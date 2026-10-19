// Every explicit split creates two independent paths. The caller supplies only
// visible children so private branches cannot affect another user's numbering.
export function planForkBranches({sourceName, branching = false, children = []}) {
  if (!branching) return [{name: sourceName.slice(0, 65) + " · Fork"}];
  const largestIndex = children.reduce((max, child) => Number.isSafeInteger(child.branchIndex) && child.branchIndex > 0
    ? Math.max(max, child.branchIndex) : max, 0);
  const firstIndex = Math.max(children.length, largestIndex) + 1;
  return Array.from({length: 2}, (_, offset) => {
    const branchIndex = firstIndex + offset;
    const suffix = " · 가지 " + branchIndex;
    return {name: sourceName.slice(0, 80 - suffix.length) + suffix, branchIndex};
  });
}
