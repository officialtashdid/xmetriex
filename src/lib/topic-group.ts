/**
 * টপিক-গ্রুপ হাবের শেয়ার্ড হেল্পার — সেলফ প্র্যাকটিস (PracticeHub) ও
 * প্রশ্নব্যাংক (question-bank) — দুই পেজেই একই টপিক-গ্রুপ কার্ড-গ্রিড সাজানো হয়।
 */

export interface HubNode {
  name: string;
  fullPath: string;
  count: number;
  children: HubNode[];
}

/** গ্রুপ-কার্ডের রঙিন টাইল (Live MCQ-স্টাইল) — Tailwind literal-ই থাকা চাই। */
export const TILE_COLORS = [
  "from-emerald-500 to-teal-600",
  "from-indigo-500 to-violet-600",
  "from-rose-500 to-pink-600",
  "from-amber-500 to-orange-600",
  "from-sky-500 to-blue-600",
  "from-fuchsia-500 to-purple-600",
  "from-lime-500 to-green-600",
  "from-cyan-500 to-teal-600",
  "from-red-500 to-rose-600",
  "from-blue-500 to-indigo-600"
];

export const colorFor = (index: number) => TILE_COLORS[index % TILE_COLORS.length];

/**
 * টপিক-পাথের তালিকা ({name: "বাংলা > ব্যাকরণ > ক্রিয়াপদ", count}) →
 * ওজনযুক্ত (প্রশ্নসংখ্যাসহ) N-স্তরের ট্রি। প্রতি পূর্বপুরুষ নোডে ওজন জমে,
 * তাই ফোল্ডারের কাউন্ট = তার গোটা সাবট্রির প্রশ্নসংখ্যা।
 */
export function buildTopicGroupTree(topics: { name: string; count: number }[]): HubNode[] {
  interface Inner {
    name: string;
    fullPath: string;
    count: number;
    children: Map<string, Inner>;
  }
  const rootMap = new Map<string, Inner>();

  topics.forEach((t) => {
    const segs = String(t.name || "")
      .split(/\s*[>›/|]\s*/)
      .map((s) => s.trim())
      .filter(Boolean);
    if (segs.length === 0) return;
    let currentMap = rootMap;
    let acc = "";
    segs.forEach((seg) => {
      acc = acc ? `${acc} > ${seg}` : seg;
      let node = currentMap.get(seg);
      if (!node) {
        node = { name: seg, fullPath: acc, count: 0, children: new Map() };
        currentMap.set(seg, node);
      }
      node.count += t.count;
      currentMap = node.children;
    });
  });

  const formatNode = (inner: Inner): HubNode => ({
    name: inner.name,
    fullPath: inner.fullPath,
    count: inner.count,
    children: Array.from(inner.children.values())
      .map(formatNode)
      .sort((a, b) => (b.count !== a.count ? b.count - a.count : a.name.localeCompare(b.name, "bn")))
  });

  return Array.from(rootMap.values())
    .map(formatNode)
    .sort((a, b) => (b.count !== a.count ? b.count - a.count : a.name.localeCompare(b.name, "bn")));
}

/** প্রতিটি টপিক-পাথের নিচে কত প্রশ্ন আছে (গ্রুপ/সাবটপিক কাউন্ট)। */
export function buildTopicCountMap(nodes: HubNode[]): Map<string, number> {
  const map = new Map<string, number>();
  const walk = (list: HubNode[]) => {
    list.forEach((n) => {
      map.set(n.fullPath, n.count);
      walk(n.children);
    });
  };
  walk(nodes);
  return map;
}

/**
 * ০-প্রশ্ন গ্রুপ/সাব-টপিক বাদ দিয়ে ট্রি ছেঁটে দেয়।
 *
 * কেন: কিছু নিবন্ধিত টপিকে এখনো কোনো প্রশ্ন যোগ করা হয়নি, আর কিছু টপিকের সব
 * প্রশ্ন চলমান (লাইভ) পরীক্ষায় লক করা — ফলাফল প্রকাশের আগে সেগুলো গোনা হয় না।
 * এমন কার্ড দেখিয়ে ক্লিক করতে দিলে শিক্ষার্থী ঢুকে "এই নির্বাচনে কোনো প্রশ্ন
 * নেই" বার্তা পায়, আর গোটা প্রশ্নব্যাংকটা খালি বলে মনে হয়। তাই খালি গ্রুপ
 * গ্রিড থেকেই বাদ — যা দেখা যায়, তাতে ট্যাপ করলে প্রশ্ন পাওয়া নিশ্চিত।
 *
 * কাউন্ট প্রতিটি পূর্বপুরুষে জমা হয় (ফোল্ডারের কাউন্ট = গোটা সাবট্রি), তাই
 * count === 0 মানে পুরো শাখাটাই খালি — নিরাপদে বাদ দেওয়া যায়।
 */
export function pruneEmptyNodes(nodes: HubNode[]): HubNode[] {
  return nodes
    .filter((n) => n.count > 0)
    .map((n) => ({ ...n, children: pruneEmptyNodes(n.children) }));
}
