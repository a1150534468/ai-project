export function splitRepeatBlocks(value: string): readonly string[] {
  const blocks = value
    .trim()
    .split(/\n\s*\n+/)
    .map((block) => block.trim())
    .filter((block) => block.length > 0);
  return blocks.length > 0 ? blocks : [""];
}

export function composeRepeatBlocks(blocks: readonly string[]): string {
  return blocks
    .map((block) => block.trim())
    .filter((block) => block.length > 0)
    .join("\n\n");
}

export function updateRepeatBlock(value: string, index: number, nextBlock: string): string {
  return composeRepeatBlocks(splitRepeatBlocks(value).map((block, blockIndex) => blockIndex === index ? nextBlock : block));
}

export function removeRepeatBlock(value: string, index: number): string {
  const nextBlocks = splitRepeatBlocks(value).filter((_, blockIndex) => blockIndex !== index);
  return composeRepeatBlocks(nextBlocks);
}

export function appendRepeatBlock(value: string, nextBlock: string): string {
  return composeRepeatBlocks([...splitRepeatBlocks(value), nextBlock]);
}
