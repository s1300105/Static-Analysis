// 再帰がスタックを使い切るまでの深さを返す（stackSizeMb が効いているかの確認用）
export default function () {
  let depth = 0;
  const dive = () => {
    depth++;
    dive();
  };
  try {
    dive();
  } catch {
    return depth;
  }
}
