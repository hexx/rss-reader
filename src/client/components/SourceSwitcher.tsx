import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
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
    <section className="flex flex-col gap-3 px-8 pt-4" aria-label="表示ソース">
      {/* Desktop view */}
      <div className="hidden flex-wrap gap-2 md:flex" role="toolbar" aria-label="記事の表示ソース">
        <Button
          variant={selectedSourceUrl === undefined ? 'default' : 'outline'}
          size="sm"
          onClick={() => onSelectSource(undefined)}
        >
          すべての記事
        </Button>
        {sources.map((source) => (
          <Button
            key={source.id}
            variant={selectedSourceUrl === source.siteUrl ? 'default' : 'outline'}
            size="sm"
            title={source.siteUrl}
            onClick={() => onSelectSource(source.siteUrl)}
            className="gap-2"
          >
            {source.displayTitle}
            <Badge variant="secondary" className="ml-1">
              {source.unreadCount}/{source.articleCount}
            </Badge>
          </Button>
        ))}
      </div>

      {/* Mobile view */}
      <label className="flex flex-col gap-1 md:hidden" htmlFor="source-switcher-select">
        <span className="text-muted-foreground text-sm">表示ソース</span>
        <select
          id="source-switcher-select"
          className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
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
