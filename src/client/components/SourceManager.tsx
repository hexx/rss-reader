import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Separator } from '@/components/ui/separator';
import { useCallback, useState, type FormEvent } from 'react';

import type { Source } from '../types.js';

type SourceManagerProps = {
  onAddSubscription: (siteUrl: string) => Promise<void>;
  onRemoveSubscription: (siteUrl: string) => Promise<void>;
  sources: Source[];
};

function normalizeError(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

export function SourceManager({
  onAddSubscription,
  onRemoveSubscription,
  sources,
}: SourceManagerProps) {
  const [siteUrl, setSiteUrl] = useState('');
  const [status, setStatus] = useState('購読ソースを表示しています。');

  const handleSubmit = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      const normalizedSiteUrl = siteUrl.trim();
      if (normalizedSiteUrl.length === 0) {
        setStatus('購読URLを入力してください。');
        return;
      }

      try {
        await onAddSubscription(normalizedSiteUrl);
        setSiteUrl('');
        setStatus('購読を追加しました。');
      } catch (error) {
        setStatus(normalizeError(error, '購読の追加に失敗しました。'));
      }
    },
    [onAddSubscription, siteUrl],
  );

  const handleRemove = useCallback(
    async (targetSiteUrl: string) => {
      try {
        await onRemoveSubscription(targetSiteUrl);
        setStatus('購読を解除しました。');
      } catch (error) {
        setStatus(normalizeError(error, '購読解除に失敗しました。'));
      }
    },
    [onRemoveSubscription],
  );

  return (
    <div className="flex flex-col gap-4 min-w-0">
      <div>
        <h2 className="font-semibold text-lg">購読設定</h2>
        <p className="mt-1 text-muted-foreground text-sm">
          RSSソースを追加・解除します。
        </p>
      </div>

      <form className="flex gap-2 min-w-0" onSubmit={handleSubmit}>
        <Input
          id="subscription-input"
          name="siteUrl"
          type="url"
          placeholder="RSSのURLを追加"
          autoComplete="url"
          required
          value={siteUrl}
          onChange={(event) => setSiteUrl(event.target.value)}
          className="min-w-0 flex-1"
        />
        <Button type="submit">追加</Button>
      </form>

      <p className="text-muted-foreground text-sm">{status}</p>

      <Separator />

      <ScrollArea className="h-[calc(100vh-280px)]">
        <nav aria-label="RSS sources">
          <ul className="flex flex-col gap-2 min-w-0">
            {sources.length === 0 ? (
              <li>
                <p className="text-muted-foreground text-sm">購読ソースがまだありません。</p>
              </li>
            ) : (
              sources.map((source) => (
                <li key={source.id} className="flex items-center gap-2 min-w-0">
                  <div
                    className="flex flex-1 items-center gap-2 min-w-0 rounded-lg bg-muted/50 p-3"
                    title={source.siteUrl}
                  >
                    <span className="truncate font-medium text-sm">
                      {source.displayTitle}
                    </span>
                    <Badge variant="secondary" className="ml-auto shrink-0">
                      {source.unreadCount}/{source.articleCount}
                    </Badge>
                  </div>
                  <Button
                    variant="destructive"
                    size="sm"
                    title={source.siteUrl}
                    onClick={() => void handleRemove(source.siteUrl)}
                  >
                    解除
                  </Button>
                </li>
              ))
            )}
          </ul>
        </nav>
      </ScrollArea>
    </div>
  );
}
