const preferredSeparators = ['\n\n', '\n', '。', '！', '？', '.'];

function findChunkBoundary(segment: string, maxChunkSize: number): number {
  const minimumBoundary = Math.max(1, Math.floor(maxChunkSize * 0.6));

  const candidates = preferredSeparators
    .map((separator, priority) => {
      const index = segment.lastIndexOf(separator);
      if (index < 0) {
        return null;
      }

      return {
        boundary: index + separator.length,
        priority,
      };
    })
    .filter((candidate): candidate is { boundary: number; priority: number } => {
      return candidate !== null && candidate.boundary >= minimumBoundary;
    });

  if (candidates.length === 0) {
    return segment.length;
  }

  candidates.sort((left, right) => right.boundary - left.boundary || left.priority - right.priority);

  return candidates[0]!.boundary;
}

export function chunkText(text: string, maxChunkSize: number): string[] {
  if (!Number.isInteger(maxChunkSize) || maxChunkSize <= 0) {
    throw new RangeError('maxChunkSize must be a positive integer');
  }

  const normalizedText = text.trim();
  if (normalizedText.length === 0) {
    return [];
  }

  if (normalizedText.length <= maxChunkSize) {
    return [normalizedText];
  }

  const chunks: string[] = [];
  let start = 0;

  while (start < normalizedText.length) {
    const end = Math.min(start + maxChunkSize, normalizedText.length);
    const segment = normalizedText.slice(start, end);
    const boundary = end === normalizedText.length ? segment.length : findChunkBoundary(segment, maxChunkSize);
    const chunk = normalizedText.slice(start, start + boundary);

    if (chunk.length > 0) {
      chunks.push(chunk);
    }

    start += boundary;
  }

  return chunks;
}
