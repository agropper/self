export const getFileNameFromKey = (key) => {
  const parts = String(key || '').split('/').filter(Boolean);
  return parts.length ? parts[parts.length - 1] : 'unknown';
};

export const getFolderLabelFromKey = (key) => {
  const parts = String(key || '').split('/').filter(Boolean);
  if (parts.length < 2) return 'unknown';
  if (parts[1] === 'archived') return 'archived';
  if (parts[1] === 'Lists') return 'Lists';
  if (parts.length === 2) return 'root';
  return parts[1];
};

export const logWizMove = (fileName, fromLabel, toLabel) => {
  console.log(`[WIZ] File ${fileName} moved from ${fromLabel} to ${toLabel}`);
};

export const logWizMoveByKey = (sourceKey, destKey) => {
  const fileName = getFileNameFromKey(destKey || sourceKey);
  const fromLabel = getFolderLabelFromKey(sourceKey);
  const toLabel = destKey ? getFolderLabelFromKey(destKey) : 'deleted';
  logWizMove(fileName, fromLabel, toLabel);
};
