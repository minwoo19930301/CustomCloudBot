// A split starts with two independent paths; adding another path at the same
// point leaves the existing paths intact. The caller supplies only visible
// children so private branches cannot affect another participant's response.
export function planForkBranches({sourceName, branching = false, siblingCount = 0, children = []}) {
  if (!branching) return [{name: sourceName.slice(0, 65) + " · Fork"}];
  const count = siblingCount === 0 ? 2 : 1;
  const largestIndex = children.reduce((max, child) => Number.isSafeInteger(child.branchIndex) && child.branchIndex > 0
    ? Math.max(max, child.branchIndex) : max, 0);
  const firstIndex = Math.max(children.length, largestIndex) + 1;
  return Array.from({length: count}, (_, offset) => {
    const branchIndex = firstIndex + offset;
    const suffix = " · 가지 " + branchIndex;
    return {name: sourceName.slice(0, 80 - suffix.length) + suffix, branchIndex};
  });
}
