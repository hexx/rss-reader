import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ScrollArea, ScrollBar } from '@/components/ui/scroll-area';
import { Globe, LayoutGrid } from 'lucide-react';
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
  return (
    <ScrollArea className="w-full whitespace-nowrap">
      <div className="flex gap-2 pb-2">
        <Button
          variant={selectedSourceUrl === undefined ? 'default' : 'outline'}
          size="sm"
          onClick={() => onSelectSource(undefined)}
          className="shrink-0 gap-1.5"
        >
          <LayoutGrid className="size-3.5" />
          すべて
        </Button>
        {sources.map((source) => (
          <Button
            key={source.id}
            variant={selectedSourceUrl === source.siteUrl ? 'default' : 'outline'}
            size="sm"
            onClick={() => onSelectSource(source.siteUrl)}
            className="shrink-0 gap-1.5"
          >
            <Globe className="size-3.5" />
            <span className="max-w-[120px] truncate">{source.displayTitle}</span>
            {source.unreadCount > 0 && (
              <Badge
                variant={selectedSourceUrl === source.siteUrl ? 'secondary' : 'default'}
                className="ml-0.5 text-xs"
              >
                {source.unreadCount}
              </Badge>
            )}
          </Button>
        ))}
      </div>
      <ScrollBar orientation="horizontal" className="h-2" />
    </ScrollArea>
  );
}
