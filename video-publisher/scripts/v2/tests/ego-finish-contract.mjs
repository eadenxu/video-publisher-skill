export function assertSdkFinishKeep(keep) {
  if (keep === "all") return;
  const uniqueLabels = Array.isArray(keep)
    && keep.every((label, index) => typeof label === "string" && label.length > 0 && keep.indexOf(label) === index);
  if (uniqueLabels) return;
  throw new Error('task.finish keep must be "all" or an array of unique non-empty Page labels. Expected: await task.finish({ keep })');
}
