type PausedUpload = { file: File; parentId: string };
const pending = new Map<string, PausedUpload[]>();
export function pendingUploads(scope: string): PausedUpload[] {
  return [...(pending.get(scope) ?? [])];
}
export function queueUpload(scope: string, upload: PausedUpload): void {
  const items = pending.get(scope) ?? [];
  if (
    !items.some(
      (item) => item.file === upload.file && item.parentId === upload.parentId,
    )
  )
    items.push(upload);
  pending.set(scope, items);
}
export function finishUpload(
  scope: string,
  file: File,
  parentId: string,
): void {
  pending.set(
    scope,
    (pending.get(scope) ?? []).filter(
      (item) => item.file !== file || item.parentId !== parentId,
    ),
  );
}
