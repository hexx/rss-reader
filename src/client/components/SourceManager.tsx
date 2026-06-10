import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Separator } from '@/components/ui/separator';
import { Skeleton } from '@/components/ui/skeleton';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { Globe, Loader2, Plus, Rss, Trash2 } from 'lucide-react';
import { useCallback, useState, type FormEvent } from 'react';

import type { Source } from '../types.js';

type SourceManagerProps = {
  onAddSubscription: (siteUrl: string) => Promise<void>;
  onRemoveSubscription: (siteUrl: string) => Promise<void>;
  sources: Source[];
  isLoading?: boolean;
  onSelectSource?: (siteUrl?: string) => void;
  selectedSourceUrl?: string | undefined;
};

function normalizeError(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

function SourceSkeleton() {
  return (
    <div className="flex items-center gap-2 p-3 rounded-lg">
      <Skeleton className="size-8 rounded-full" />
      <div className="flex-1 space-y-1.5">
        <Skeleton className="h-4 w-3/4" />
        <Skeleton className="h-3 w-1/2" />
      </div>
    </div>
  );
}

export function SourceManager({
  onAddSubscription,
  onRemoveSubscription,
  sources,
  isLoading = false,
  onSelectSource,
  selectedSourceUrl,
}: SourceManagerProps) {
  const [siteUrl, setSiteUrl] = useState('');
  const [isAdding, setIsAdding] = useState(false);
  const [removingId, setRemovingId] = useState<string | null>(null);
  const [error, setError] = useState('');

  const handleSubmit = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      const normalizedSiteUrl = siteUrl.trim();
      if (normalizedSiteUrl.length === 0) {
        setError('購読URLを入力してください。');
        return;
      }

      setIsAdding(true);
      setError('');

      try {
        await onAddSubscription(normalizedSiteUrl);
        setSiteUrl('');
      } catch (err) {
        setError(normalizeError(err, '購読の追加に失敗しました。'));
      } finally {
        setIsAdding(false);
      }
    },
    [onAddSubscription, siteUrl],
  );

  const handleRemove = useCallback(
    async (targetSiteUrl: string) => {
      setRemovingId(targetSiteUrl);
      setError('');

      try {
        await onRemoveSubscription(targetSiteUrl);
      } catch (err) {
        setError(normalizeError(err, '購読解除に失敗しました。'));
      } finally {
        setRemovingId(null);
      }
    },
    [onRemoveSubscription],
  );

  return (
    <div className="flex flex-col h-full min-h-0">
      {/* Header */}
      <div className="p-4 pb-3">
        <div className="flex items-center gap-2 mb-1">
          <Rss className="size-5 text-primary" />
          <h2 className="font-semibold">購読設定</h2>
        </div>
        <p className="text-xs text-muted-foreground">
          RSSソースを追加・管理します
        </p>
      </div>

      <Separator />

      {/* Add form */}
      <form className="p-4 pb-3" onSubmit={handleSubmit}>
        <div className="flex gap-2">
          <div className="relative flex-1">
            <Globe className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground" />
            <Input
              id="subscription-input"
              name="siteUrl"
              type="url"
              placeholder="RSSフィードのURL"
              autoComplete="url"
              required
              value={siteUrl}
              onChange={(event) => {
                setSiteUrl(event.target.value);
                setError('');
              }}
              className="pl-9"
              disabled={isAdding}
            />
          </div>
          <Button type="submit" size="icon" disabled={isAdding}>
            {isAdding ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <Plus className="size-4" />
            )}
            <span className="sr-only">追加</span>
          </Button>
        </div>
        {error && (
          <p className="mt-2 text-xs text-destructive">{error}</p>
        )}
      </form>

      <Separator />

      {/* Source list */}
      <ScrollArea className="flex-1 min-h-0">
        <div className="p-4 pt-2 space-y-1">
          {isLoading ? (
            <>
              <SourceSkeleton />
              <SourceSkeleton />
              <SourceSkeleton />
            </>
          ) : sources.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-8 text-center">
              <Rss className="size-10 text-muted-foreground/30 mb-3" />
              <p className="text-sm font-medium text-muted-foreground">
                購読ソースがありません
              </p>
              <p className="text-xs text-muted-foreground/70 mt-1">
                上のフォームからRSSフィードを追加してください
              </p>
            </div>
          ) : (
            sources.map((source) => {
              const isSelected = selectedSourceUrl === source.siteUrl;
              const isRemoving = removingId === source.siteUrl;

              return (
                <div
                  key={source.id}
                  className={`group flex items-center gap-2 rounded-lg p-2.5 transition-colors cursor-pointer hover:bg-muted/50 ${
                    isSelected ? 'bg-primary/10 border border-primary/20' : ''
                  }`}
                  onClick={() => onSelectSource?.(isSelected ? undefined : source.siteUrl)}
                  role="button"
                  tabIndex={0}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      onSelectSource?.(isSelected ? undefined : source.siteUrl);
                    }
                  }}
                >
                  <div className="flex size-8 items-center justify-center rounded-full bg-primary/10 text-primary">
                    <Globe className="size-4" />
                  </div>

                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium truncate">
                      {source.displayTitle}
                    </p>
                    <p className="text-xs text-muted-foreground truncate">
                      {source.siteUrl}
                    </p>
                  </div>

                  <div className="flex items-center gap-1">
                    {source.unreadCount > 0 && (
                      <Badge variant="secondary" className="text-xs">
                        {source.unreadCount}
                      </Badge>
                    )}

                    <Tooltip>
                      <TooltipTrigger>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="size-7 opacity-0 group-hover:opacity-100 transition-opacity"
                          onClick={(e) => {
                            e.stopPropagation();
                            void handleRemove(source.siteUrl);
                          }}
                          disabled={isRemoving}
                        >
                          {isRemoving ? (
                            <Loader2 className="size-3 animate-spin" />
                          ) : (
                            <Trash2 className="size-3 text-destructive" />
                          )}
                          <span className="sr-only">購読解除</span>
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent>購読解除</TooltipContent>
                    </Tooltip>
                  </div>
                </div>
              );
            })
          )}
        </div>
      </ScrollArea>

      {/* Footer */}
      {!isLoading && sources.length > 0 && (
        <>
          <Separator />
          <div className="p-4 text-xs text-muted-foreground text-center">
            {sources.length} 件のフィードを購読中
          </div>
        </>
      )}
    </div>
  );
}
