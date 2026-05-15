const articlesElement = document.querySelector('#articles');
const statusElement = document.querySelector('#status');
const searchForm = document.querySelector('#search-form');
const searchInput = document.querySelector('#search-input');
const subscriptionForm = document.querySelector('#subscription-form');
const subscriptionInput = document.querySelector('#subscription-input');
const unreadOnlyToggle = document.querySelector('#unread-only-toggle');
const syncButton = document.querySelector('#sync-button');
const sourcesList = document.querySelector('#sources-list');
const template = document.querySelector('#article-card-template');
const aiAnswerSection = document.querySelector('#ai-answer-section');
const aiAnswerElement = document.querySelector('#ai-answer');

const state = {
  query: '',
  sourceUrl: null,
  unreadOnly: true,
};

let latestSources = [];

unreadOnlyToggle.checked = state.unreadOnly;

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

function sourceHostname(siteUrl) {
  try {
    return new URL(siteUrl).hostname;
  } catch {
    return siteUrl;
  }
}

function sourceLabel(source) {
  if (typeof source === 'string') {
    return sourceHostname(source);
  }

  const title = source.displayTitle?.trim() || source.title?.trim();
  return title && title.length > 0 ? title : sourceHostname(source.siteUrl);
}

function getReferenceMap(references) {
  const map = new Map();
  references.forEach((reference, index) => {
    map.set(index + 1, reference);
  });

  return map;
}

function appendReferenceText(parent, text, referenceMap) {
  const referencePattern = /\[(\d+)\]/g;
  let lastIndex = 0;
  let match = referencePattern.exec(text);

  while (match) {
    if (match.index > lastIndex) {
      parent.append(document.createTextNode(text.slice(lastIndex, match.index)));
    }

    const referenceNumber = Number(match[1]);
    const reference = referenceMap.get(referenceNumber);
    if (reference) {
      const link = document.createElement('a');
      link.href = `#article-${reference.id}`;
      link.className = 'ai-answer__reference';
      link.textContent = `[${referenceNumber}]`;
      link.title = reference.title;
      parent.append(link);
    } else {
      parent.append(document.createTextNode(match[0]));
    }

    lastIndex = referencePattern.lastIndex;
    match = referencePattern.exec(text);
  }

  if (lastIndex < text.length) {
    parent.append(document.createTextNode(text.slice(lastIndex)));
  }
}

function renderAiAnswer(answer, references) {
  const snippet = typeof answer === 'string' ? answer.trim() : '';
  if (snippet.length === 0) {
    aiAnswerElement.replaceChildren();
    aiAnswerSection.hidden = true;
    return;
  }

  const referenceMap = getReferenceMap(references);
  const fragment = document.createDocumentFragment();
  const lines = snippet.split(/\r?\n/);
  let paragraphLines = [];
  let listElement = null;

  const flushParagraph = () => {
    if (paragraphLines.length === 0) {
      return;
    }

    const paragraph = document.createElement('p');
    appendReferenceText(paragraph, paragraphLines.join(' '), referenceMap);
    fragment.append(paragraph);
    paragraphLines = [];
  };

  const flushList = () => {
    if (!listElement) {
      return;
    }

    fragment.append(listElement);
    listElement = null;
  };

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      flushParagraph();
      flushList();
      continue;
    }

    const listMatch = trimmed.match(/^[-*]\s+\[(\d+)\]\s*(.+)$/);
    if (listMatch) {
      flushParagraph();
      if (!listElement) {
        listElement = document.createElement('ul');
      }

      const referenceNumber = Number(listMatch[1]);
      const reference = referenceMap.get(referenceNumber);
      const listItem = document.createElement('li');

      if (reference) {
        const numberLink = document.createElement('a');
        numberLink.href = `#article-${reference.id}`;
        numberLink.className = 'ai-answer__reference';
        numberLink.textContent = `[${referenceNumber}]`;
        numberLink.title = reference.title;

        const titleLink = document.createElement('a');
        titleLink.href = reference.url;
        titleLink.target = '_blank';
        titleLink.rel = 'noreferrer noopener';
        titleLink.textContent = listMatch[2].trim() || reference.title;
        titleLink.title = reference.url;

        listItem.append(numberLink, document.createTextNode(' '), titleLink);
      } else {
        appendReferenceText(listItem, trimmed, referenceMap);
      }

      listElement.append(listItem);
      continue;
    }

    flushList();
    paragraphLines.push(trimmed);
  }

  flushParagraph();
  flushList();
  aiAnswerElement.replaceChildren(fragment);
  aiAnswerSection.hidden = false;
}

function sanitizeSnippetHtml(html) {
  const templateElement = document.createElement('template');
  templateElement.innerHTML = html;

  const allowedTags = new Set(['P', 'UL', 'LI', 'OL', 'STRONG', 'EM', 'BR', 'A']);
  const elements = Array.from(templateElement.content.querySelectorAll('*')).reverse();

  for (const element of elements) {
    if (!allowedTags.has(element.tagName)) {
      const childNodes = Array.from(element.childNodes);
      element.replaceWith(...childNodes);
      continue;
    }

    for (const attribute of Array.from(element.attributes)) {
      if (element.tagName === 'A' && attribute.name === 'href') {
        const href = attribute.value.trim();
        if (!/^https?:\/\//i.test(href) && !href.startsWith('mailto:') && !href.startsWith('#')) {
          element.removeAttribute(attribute.name);
        }
        continue;
      }

      if (
        element.tagName === 'A' &&
        (attribute.name === 'title' || attribute.name === 'target' || attribute.name === 'rel')
      ) {
        continue;
      }

      element.removeAttribute(attribute.name);
    }

    if (element.tagName === 'A' && !element.getAttribute('rel')) {
      element.setAttribute('rel', 'noreferrer noopener');
    }
  }

  return templateElement.innerHTML;
}

function setSnippetHtml(element, html, fallbackText) {
  const snippet = typeof html === 'string' ? html.trim() : '';
  if (snippet.length === 0) {
    element.textContent = fallbackText;
    return;
  }

  element.innerHTML = sanitizeSnippetHtml(snippet);
}

function setAiAnswer(answer, references = []) {
  const normalizedAnswer = typeof answer === 'string' ? answer : '';
  if (normalizedAnswer.trim().length === 0) {
    aiAnswerElement.replaceChildren();
    aiAnswerSection.hidden = true;
    return;
  }

  renderAiAnswer(normalizedAnswer, Array.isArray(references) ? references : []);
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
  allButton.title = 'すべての記事を表示';
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

    const row = document.createElement('div');
    row.className = 'source-row';

    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'source-item';
    button.dataset.sourceUrl = source.siteUrl;
    button.textContent = `${sourceLabel(source)} (${source.unreadCount} / ${source.articleCount})`;
    button.title = source.siteUrl;
    button.addEventListener('click', () => {
      state.sourceUrl = source.siteUrl;
      state.query = '';
      searchInput.value = '';
      void loadArticles(source.siteUrl);
    });

    const removeButton = document.createElement('button');
    removeButton.type = 'button';
    removeButton.className = 'source-remove';
    removeButton.textContent = '解除';
    removeButton.title = source.siteUrl;
    removeButton.addEventListener('click', () => {
      void removeSubscription(source.siteUrl).catch((error) => {
        setStatus(error instanceof Error ? error.message : '購読解除に失敗しました。');
      });
    });

    row.append(button, removeButton);
    item.append(row);
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
  const articleUrl = fragment.querySelector('.card__url');
  const articleLink = fragment.querySelector('.card__article-link');
  const comments = fragment.querySelector('.comments');
  const commentHeading = fragment.querySelector('.card__comments-heading');

  card.classList.toggle('is-read', Boolean(article.isRead));
  card.classList.toggle('is-unread', !article.isRead);
  card.id = `article-${article.id}`;
  card.dataset.articleId = article.id;

  title.textContent = article.title;
  title.href = article.url;
  source.textContent = sourceLabel(article.siteUrl);
  date.textContent = formatDate(article.publishedAt ?? article.createdAt);
  readToggle.textContent = article.isRead ? '未読に戻す' : '既読にする';

  setSnippetHtml(articleSummary, article.summary, '記事の要約はまだありません。');
  setSnippetHtml(hatenaSummary, article.hatenaSummary, 'はてブの反応要約はまだありません。');
  articleUrl.textContent = article.url;
  articleLink.href = article.url;
  articleLink.textContent = '記事を読む';
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

function buildArticlesUrl(sourceUrl = state.sourceUrl) {
  const params = new URLSearchParams();
  if (sourceUrl) {
    params.set('source', sourceUrl);
  }

  params.set('unread_only', String(state.unreadOnly));

  const query = params.toString();
  return query.length > 0 ? `/api/articles?${query}` : '/api/articles';
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

async function addSubscription(siteUrl) {
  const response = await fetch('/api/subscriptions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ siteUrl }),
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload.error || '購読の追加に失敗しました。');
  }

  subscriptionInput.value = '';
  setStatus('購読を追加しました。');
  await loadSources();
  await loadArticles(state.sourceUrl);
}

async function removeSubscription(siteUrl) {
  const response = await fetch('/api/subscriptions', {
    method: 'DELETE',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ siteUrl }),
  });

  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    throw new Error(payload.error || '購読解除に失敗しました。');
  }

  if (state.sourceUrl === siteUrl) {
    state.sourceUrl = null;
  }

  await loadSources();
  await refreshCurrentView();
}

async function loadArticles(sourceUrl = state.sourceUrl) {
  const url = buildArticlesUrl(sourceUrl);
  setAiAnswer('');
  setStatus(state.unreadOnly ? '未読記事を読み込み中...' : sourceUrl ? '記事を読み込み中...' : '最新記事を読み込み中...');

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error('記事の読み込みに失敗しました。');
  }

  const data = await response.json();
  renderArticles(data.articles ?? []);
  updateSourceListActiveState();
  setStatus(
    state.unreadOnly
      ? '未読記事を表示しています。'
      : sourceUrl
        ? 'ソースで絞り込んだ記事を表示しています。'
        : '最新記事を表示しています。',
  );
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
    setAiAnswer('');
    setStatus('検索中...');
    const response = await fetch(`/api/search?q=${encodeURIComponent(normalizedQuery)}`);
    const data = await response.json();
    if (!response.ok) {
      throw new Error(data.error || '検索に失敗しました。');
    }

    renderArticles(data.results ?? []);
    setAiAnswer(
      typeof data.aiAnswer === 'string' ? data.aiAnswer : '',
      Array.isArray(data.references) ? data.references : [],
    );
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

unreadOnlyToggle.addEventListener('change', () => {
  state.unreadOnly = unreadOnlyToggle.checked;
  if (state.query.trim().length > 0) {
    void runSearch(state.query);
    return;
  }

  void loadArticles(state.sourceUrl);
});

searchForm.addEventListener('submit', (event) => {
  event.preventDefault();
  void runSearch(searchInput.value);
});

subscriptionForm.addEventListener('submit', (event) => {
  event.preventDefault();
  void addSubscription(subscriptionInput.value).catch((error) => {
    setStatus(error instanceof Error ? error.message : '購読の追加に失敗しました。');
  });
});

syncButton.addEventListener('click', () => {
  void triggerSync();
});

void Promise.all([loadSources(), loadArticles()]).catch((error) => {
  setStatus(error instanceof Error ? error.message : '読み込みに失敗しました。');
});
