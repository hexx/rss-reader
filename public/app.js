const articlesElement = document.querySelector('#articles');
const statusElement = document.querySelector('#status');
const searchForm = document.querySelector('#search-form');
const searchInput = document.querySelector('#search-input');
const syncButton = document.querySelector('#sync-button');
const sourcesList = document.querySelector('#sources-list');
const template = document.querySelector('#article-card-template');

const state = {
  query: '',
  sourceUrl: null,
};

let latestSources = [];

function setStatus(message) {
  statusElement.textContent = message;
}

function formatDate(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return '日時不明';
  }

  return new Intl.DateTimeFormat('ja-JP', {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(date);
}

function sourceLabel(siteUrl) {
  try {
    return new URL(siteUrl).hostname;
  } catch {
    return siteUrl;
  }
}

function updateSourceListActiveState() {
  const items = sourcesList.querySelectorAll('[data-source-url]');
  items.forEach((item) => {
    const itemSourceUrl = item.dataset.sourceUrl || null;
    const isAllItem = itemSourceUrl === '';
    const isActive = isAllItem ? state.sourceUrl === null : itemSourceUrl === state.sourceUrl;
    item.classList.toggle('is-active', isActive);
  });
}

function renderSources(sources) {
  sourcesList.replaceChildren();

  const allItem = document.createElement('li');
  const allButton = document.createElement('button');
  allButton.type = 'button';
  allButton.className = 'source-item';
  allButton.textContent = 'すべて';
  allButton.dataset.sourceUrl = '';
  allButton.addEventListener('click', () => {
    state.sourceUrl = null;
    state.query = '';
    searchInput.value = '';
    void loadArticles(null);
  });
  allItem.append(allButton);
  sourcesList.append(allItem);

  for (const source of sources) {
    const item = document.createElement('li');
    item.dataset.sourceUrl = source.siteUrl;

    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'source-item';
    button.dataset.sourceUrl = source.siteUrl;
    button.textContent = `${sourceLabel(source.siteUrl)} (${source.articleCount})`;
    button.addEventListener('click', () => {
      state.sourceUrl = source.siteUrl;
      state.query = '';
      searchInput.value = '';
      void loadArticles(source.siteUrl);
    });

    item.append(button);
    sourcesList.append(item);
  }

  updateSourceListActiveState();
}

function createCard(article) {
  const fragment = template.content.cloneNode(true);
  const card = fragment.querySelector('.card');
  const title = fragment.querySelector('.card__title');
  const source = fragment.querySelector('.card__source');
  const date = fragment.querySelector('.card__date');
  const readToggle = fragment.querySelector('.card__read-toggle');
  const articleSummary = fragment.querySelector('.card__article-summary');
  const hatenaSummary = fragment.querySelector('.card__hatena-summary');
  const comments = fragment.querySelector('.comments');
  const commentHeading = fragment.querySelector('.card__comments-heading');

  card.classList.toggle('is-read', Boolean(article.isRead));
  card.classList.toggle('is-unread', !article.isRead);
  card.dataset.articleId = article.id;

  title.textContent = article.title;
  title.href = article.url;
  source.textContent = sourceLabel(article.siteUrl);
  date.textContent = formatDate(article.createdAt);
  readToggle.textContent = article.isRead ? '未読に戻す' : '既読にする';

  articleSummary.textContent = article.summary || '記事の要約はまだありません。';
  hatenaSummary.textContent = article.hatenaSummary || 'はてブの反応要約はまだありません。';
  commentHeading.textContent = '個別コメント';

  const bookmarkList = Array.isArray(article.bookmarks) ? article.bookmarks : [];
  comments.replaceChildren();
  if (bookmarkList.length === 0) {
    const item = document.createElement('li');
    item.textContent = 'はてブコメントはまだありません。';
    comments.append(item);
  } else {
    for (const bookmark of bookmarkList) {
      const item = document.createElement('li');
      item.textContent = `${bookmark.user}: ${bookmark.comment}`;
      comments.append(item);
    }
  }

  readToggle.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    void markArticleRead(article.id, !article.isRead);
  });

  return fragment;
}

function renderArticles(list) {
  articlesElement.replaceChildren();

  if (list.length === 0) {
    articlesElement.innerHTML = '<p class="empty">記事がまだありません。</p>';
    return;
  }

  for (const article of list) {
    articlesElement.append(createCard(article));
  }
}

async function loadSources() {
  const response = await fetch('/api/sources');
  if (!response.ok) {
    throw new Error('RSSソースの読み込みに失敗しました。');
  }

  const data = await response.json();
  latestSources = Array.isArray(data.sources) ? data.sources : [];
  renderSources(latestSources);
}

async function loadArticles(sourceUrl = state.sourceUrl) {
  const url = sourceUrl ? `/api/articles?source=${encodeURIComponent(sourceUrl)}` : '/api/articles';
  setStatus(sourceUrl ? '記事を読み込み中...' : '最新記事を読み込み中...');

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error('記事の読み込みに失敗しました。');
  }

  const data = await response.json();
  renderArticles(data.articles ?? []);
  updateSourceListActiveState();
  setStatus(sourceUrl ? 'ソースで絞り込んだ記事を表示しています。' : '最新記事を表示しています。');
}

async function runSearch(query) {
  const normalizedQuery = query.trim();
  state.query = normalizedQuery;

  if (normalizedQuery.length === 0) {
    await loadArticles(state.sourceUrl);
    return;
  }

  state.sourceUrl = null;
  searchInput.value = normalizedQuery;
  updateSourceListActiveState();

  try {
    setStatus('検索中...');
    const response = await fetch(`/api/search?q=${encodeURIComponent(normalizedQuery)}`);
    const data = await response.json();
    if (!response.ok) {
      throw new Error(data.error || '検索に失敗しました。');
    }

    renderArticles(data.results ?? []);
    setStatus('検索結果を表示しています。');
  } catch (error) {
    setStatus(error instanceof Error ? error.message : '検索に失敗しました。');
  }
}

async function refreshCurrentView() {
  if (state.query.trim().length > 0) {
    await runSearch(state.query);
    return;
  }

  await loadArticles(state.sourceUrl);
}

async function markArticleRead(articleId, isRead) {
  try {
    const response = await fetch(`/api/articles/${articleId}/read`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ isRead }),
    });

    if (!response.ok) {
      const payload = await response.json().catch(() => ({}));
      throw new Error(payload.error || '既読状態の更新に失敗しました。');
    }

    await refreshCurrentView();
  } catch (error) {
    setStatus(error instanceof Error ? error.message : '既読状態の更新に失敗しました。');
  }
}

async function triggerSync() {
  syncButton.disabled = true;
  syncButton.textContent = 'Syncing...';
  setStatus('同期を開始しました。');

  try {
    const response = await fetch('/api/sync', { method: 'POST' });
    if (!response.ok) {
      throw new Error('同期の開始に失敗しました。');
    }

    setStatus('同期を開始しました。完了後に最新記事を再読み込みします。');
    window.setTimeout(() => {
      void refreshCurrentView();
      void loadSources();
    }, 4000);
  } finally {
    syncButton.disabled = false;
    syncButton.textContent = 'Sync';
  }
}

searchForm.addEventListener('submit', (event) => {
  event.preventDefault();
  void runSearch(searchInput.value);
});

syncButton.addEventListener('click', () => {
  void triggerSync();
});

void Promise.all([loadSources(), loadArticles()]).catch((error) => {
  setStatus(error instanceof Error ? error.message : '読み込みに失敗しました。');
});
