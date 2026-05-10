const articlesElement = document.querySelector('#articles');
const searchResultsElement = document.querySelector('#search-results');
const statusElement = document.querySelector('#status');
const searchForm = document.querySelector('#search-form');
const searchInput = document.querySelector('#search-input');
const syncButton = document.querySelector('#sync-button');
const template = document.querySelector('#article-card-template');

function setStatus(message) {
  statusElement.textContent = message;
}

function createCard(article) {
  const fragment = template.content.cloneNode(true);
  const card = fragment.querySelector('.card');
  const title = fragment.querySelector('.card__title');
  const summary = fragment.querySelector('.card__summary');
  const comments = fragment.querySelector('.comments');

  title.textContent = article.title;
  title.href = article.url;
  summary.textContent = article.summary || '要約はまだありません。';

  const bookmarkList = Array.isArray(article.bookmarks) ? article.bookmarks : [];
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

  card.dataset.articleId = article.id;
  return fragment;
}

function renderArticles(target, articles) {
  target.replaceChildren();
  if (articles.length === 0) {
    target.innerHTML = '<p class="empty">記事がまだありません。</p>';
    return;
  }

  for (const article of articles) {
    target.append(createCard(article));
  }
}

async function loadArticles() {
  setStatus('記事を読み込み中...');
  const response = await fetch('/api/articles');
  if (!response.ok) {
    throw new Error('記事の読み込みに失敗しました。');
  }
  const data = await response.json();
  renderArticles(articlesElement, data.articles ?? []);
  setStatus('最新記事を表示しています。');
}

async function runSearch(query) {
  if (!query.trim()) {
    renderArticles(searchResultsElement, []);
    return;
  }

  try {
    setStatus('検索中...');
    const response = await fetch(`/api/search?q=${encodeURIComponent(query)}`);
    const data = await response.json();
    if (!response.ok) {
      throw new Error(data.error || '検索に失敗しました。');
    }

    renderArticles(searchResultsElement, data.results ?? []);
    setStatus('検索結果を表示しています。');
  } catch (error) {
    setStatus(error instanceof Error ? error.message : '検索に失敗しました。');
  }
}

async function triggerSync() {
  syncButton.disabled = true;
  syncButton.textContent = 'Syncing...';
  setStatus('同期を開始しました。');

  try {
    await fetch('/api/sync', { method: 'POST' });
    setStatus('同期を開始しました。完了後に最新記事を再読み込みします。');
    window.setTimeout(() => {
      void loadArticles();
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

void loadArticles().catch((error) => {
  setStatus(error instanceof Error ? error.message : '記事の読み込みに失敗しました。');
});
