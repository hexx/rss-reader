import type { Source } from '../types.js';

type SourceSwitcherProps = {
  onSelectSource: (siteUrl?: string) => void;
  selectedSourceUrl: string | undefined;
  sources: Source[];
};

export function SourceSwitcher({
  onSelectSource,
  selectedSourceUrl,
  sources,
}: SourceSwitcherProps) {
  const selectedValue = selectedSourceUrl ?? '';

  return (
    <section className="source-switcher" aria-label="表示ソース">
      <div className="source-switcher__desktop" role="toolbar" aria-label="記事の表示ソース">
        <button
          type="button"
          className={`source-switcher__button ${selectedSourceUrl === undefined ? 'is-active' : ''}`}
          onClick={() => onSelectSource(undefined)}
        >
          すべての記事
        </button>
        {sources.map((source) => (
          <button
            key={source.id}
            type="button"
            className={`source-switcher__button ${selectedSourceUrl === source.siteUrl ? 'is-active' : ''}`}
            title={source.siteUrl}
            onClick={() => onSelectSource(source.siteUrl)}
          >
            {source.displayTitle} ({source.unreadCount}/{source.articleCount})
          </button>
        ))}
      </div>

      <label className="source-switcher__mobile" htmlFor="source-switcher-select">
        <span className="source-switcher__label">表示ソース</span>
        <select
          id="source-switcher-select"
          className="source-switcher__select"
          value={selectedValue}
          onChange={(event) => onSelectSource(event.target.value.length > 0 ? event.target.value : undefined)}
        >
          <option value="">すべての記事</option>
          {sources.map((source) => (
            <option key={source.id} value={source.siteUrl}>
              {source.displayTitle} ({source.unreadCount}/{source.articleCount})
            </option>
          ))}
        </select>
      </label>
    </section>
  );
}
