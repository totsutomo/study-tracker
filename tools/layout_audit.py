"""PC幅で「右側が空いたまま縦に積まれている」画面がないかを自動で点検する(2026-10-04)。

Scores・Moodで、カードにmax-widthの頭打ちを付けたせいで広い画面の右半分が丸ごと空く、という
同じ問題が続けて見つかったため、目視ではなく機械的に全タブ・全サブタブを確かめる。

やっていること: 各画面をPC幅で開き、パネルを縦20pxの帯に区切って、帯ごとに「見た目のある箱」
(背景・枠線のある要素、文字・画像・SVG)が右端のどこまで届いているかを測る。右端まで届かない
帯(既定は届いている割合65%未満)が合計200px以上続く画面を「右が空いている」として報告する。

使い方(本番DBにつながないよう、環境変数なしでローカルサーバーを起動してから):
  python tools/layout_audit.py [http://localhost:8011] [--width 1536] [--shots DIR]
レイアウトを変えたら、完了報告の前に1536と1280の両方で流す。
"""
import argparse
import sys

from playwright.sync_api import sync_playwright

# (タブID, サブタブのセレクタ or None, 表示名)
VIEWS = [
    ("tab-todo", None, "ToDo"),
    ("tab-calendar", None, "Calendar"),
    ("tab-study", '.side-sub-btn[data-sub="log"]', "Study/Log"),
    ("tab-study", '.side-sub-btn[data-sub="scores"]', "Study/Scores"),
    ("tab-study", '.side-sub-btn[data-sub="insights"]', "Study/Insights"),
    ("tab-mood", '.side-sub-btn[data-sub="mood"]', "Mood/Mood"),
    ("tab-mood", '.side-sub-btn[data-sub="slacking"]', "Mood/Slacking"),
    ("tab-mood", '.side-sub-btn[data-sub="sleep"]', "Mood/Sleep"),
]

MEASURE_JS = """
([minCoverage, band]) => {
  const panel = document.querySelector('.tab-panel.active');
  const pr = panel.getBoundingClientRect();
  const cs0 = getComputedStyle(panel);
  const left = pr.left + parseFloat(cs0.paddingLeft);
  const right = pr.right - parseFloat(cs0.paddingRight);
  const width = right - left;
  const boxes = [];
  for (const el of panel.querySelectorAll('*')) {
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) continue;
    const cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || cs.display === 'none' || parseFloat(cs.opacity) === 0) continue;
    const visual =
      (cs.backgroundColor && cs.backgroundColor !== 'rgba(0, 0, 0, 0)' && cs.backgroundColor !== 'transparent') ||
      parseFloat(cs.borderTopWidth) > 0 || parseFloat(cs.borderLeftWidth) > 0 ||
      ['svg', 'img', 'canvas', 'input', 'button', 'textarea', 'select'].includes(el.tagName.toLowerCase()) ||
      [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim());
    if (!visual) continue;
    boxes.push([r.top + scrollY, r.bottom + scrollY, r.right]);
  }
  const top = pr.top + scrollY, bottom = pr.bottom + scrollY;
  let emptyPx = 0, worst = 1, firstEmptyY = null;
  for (let y = top; y < bottom; y += band) {
    let maxRight = null;
    for (const [t, b, rr] of boxes) if (t < y + band && b > y) maxRight = Math.max(maxRight ?? -1e9, rr);
    if (maxRight === null) continue; // 何もない帯(カード間の隙間など)は数えない
    const cov = (maxRight - left) / width;
    if (cov < minCoverage) { emptyPx += band; worst = Math.min(worst, cov); firstEmptyY ??= Math.round(y - top); }
  }
  return { emptyPx, worst: Math.round(worst * 100), firstEmptyY, panelWidth: Math.round(width) };
}
"""


def main():
    sys.stdout.reconfigure(encoding="utf-8")  # Windowsのコンソール既定(cp1252)だと日本語で落ちる
    ap = argparse.ArgumentParser()
    ap.add_argument("base", nargs="?", default="http://localhost:8011")
    ap.add_argument("--width", type=int, default=1536)
    ap.add_argument("--min-coverage", type=float, default=0.65)
    ap.add_argument("--max-empty-px", type=int, default=200)
    ap.add_argument("--shots", default=None, help="画面写真(全体)を保存するフォルダ")
    args = ap.parse_args()

    failed = []
    with sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_page(viewport={"width": args.width, "height": 1000}, color_scheme="dark")
        page.goto(args.base, wait_until="networkidle")
        for tab_id, sub_sel, name in VIEWS:
            if sub_sel:
                page.click(sub_sel)
            else:
                page.click(f'.sidebar-nav .tab-btn[data-tab="{tab_id}"]')
            # 本番は1回の通信に2秒前後かかるので、通信が落ち着くまで待ってから測る(描画前に測ると空に見える)
            try:
                page.wait_for_load_state("networkidle", timeout=20000)
            except Exception:
                pass
            page.wait_for_timeout(800)
            r = page.evaluate(MEASURE_JS, [args.min_coverage, 20])
            bad = r["emptyPx"] >= args.max_empty_px
            mark = "NG" if bad else "ok"
            print(f"[{mark}] {name:16s} 右が空いた帯 {r['emptyPx']:5d}px (最小カバー率 {r['worst']}%, 最初の位置 y={r['firstEmptyY']})")
            if bad:
                failed.append(name)
            if args.shots:
                page.screenshot(path=f"{args.shots}/{name.replace('/', '_')}_{args.width}.png", full_page=True)
        browser.close()
    print(f"width={args.width}: " + ("すべてOK" if not failed else "要修正: " + ", ".join(failed)))
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
