// Core logic to transfer annotations from a reference document to a new version of it.
//
// The idea: instead of searching exact strings (breaks as soon as the text change a bit),
// we tokenize both documents word by word and do a fuzzy alignment. So annotations follow
// their text even when it moved somewhere else, went to another page, or was slightly edited.
//
// Rough pipeline:
//   1. index both docs (words + their position on the page)
//   2. for each annotation in the reference, figure out which words it's attached to
//   3. find those words again in the target (fuzzy, tolerates small edits)
//   4. rebuild the annotation there

const NV = () => window.NutrientViewer;

// ---- annotation type detection ----

// the SDK minifies class names so .type is undefined at runtime, instanceof is the only
// reliable way to know what we're dealing with
function getAnnotationType(a) {
  const A = NV().Annotations;
  if (a instanceof A.HighlightAnnotation) return "pspdfkit/highlight";
  if (a instanceof A.UnderlineAnnotation)  return "pspdfkit/underline";
  if (a instanceof A.StrikeOutAnnotation)  return "pspdfkit/strikeout";
  if (a instanceof A.SquiggleAnnotation)   return "pspdfkit/squiggle";
  if (a instanceof A.RedactionAnnotation)  return "pspdfkit/redact";
  if (a instanceof A.NoteAnnotation)       return "pspdfkit/note";
  if (a instanceof A.TextAnnotation)       return "pspdfkit/text";
  if (a instanceof A.InkAnnotation)        return "pspdfkit/ink";
  if (a instanceof A.RectangleAnnotation)  return "pspdfkit/shape/rectangle";
  if (a instanceof A.EllipseAnnotation)    return "pspdfkit/shape/ellipse";
  if (a instanceof A.LineAnnotation)       return "pspdfkit/shape/line";
  if (a instanceof A.PolygonAnnotation)    return "pspdfkit/shape/polygon";
  if (a instanceof A.PolylineAnnotation)   return "pspdfkit/shape/polyline";
  if (a instanceof A.ImageAnnotation)      return "pspdfkit/image";
  if (a instanceof A.WidgetAnnotation)     return "pspdfkit/widget";
  return "pspdfkit/unknown";
}

const TEXT_MARKUP_TYPES = new Set([
  "pspdfkit/highlight",
  "pspdfkit/underline",
  "pspdfkit/strikeout",
  "pspdfkit/squiggle",
  "pspdfkit/redact",
]);

// shapes that can be drawn around a text (box on a paragraph, circle on a list...)
const ENCLOSABLE_TYPES = new Set([
  "pspdfkit/ink",
  "pspdfkit/shape/rectangle",
  "pspdfkit/shape/ellipse",
  "pspdfkit/shape/line",
  "pspdfkit/shape/polygon",
  "pspdfkit/shape/polyline",
]);

// one word inside is enough, a marker dot on a single word must follow that word
const MIN_ENCLOSE_TOKENS = 1;

// ---- text helpers ----

const SEP = "";

function normWord(raw) {
  return raw.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
}

function toArray(listLike) {
  if (!listLike) return [];
  return listLike.toArray ? listLike.toArray() : Array.from(listLike);
}

function tokenize(text) {
  return (text || "").split(/\s+/).map(normWord).filter((w) => w.length > 0);
}

// how many words of the ref text we find back in the target text
function wordOverlapRatio(refText, targetText) {
  const refWords = new Set(tokenize(refText).filter((w) => w.length > 2));
  const targetWords = new Set(tokenize(targetText).filter((w) => w.length > 2));
  if (refWords.size === 0) return 0;
  let shared = 0;
  for (const w of refWords) if (targetWords.has(w)) shared++;
  return shared / refWords.size;
}

// compare the words around two locations, used to pick the right occurrence when the
// same text appears several times
function ctxOverlap(refCtx, targetCtx) {
  if (!refCtx || refCtx.length === 0) return 0.5; // nothing to compare, stay neutral
  const t = new Set(targetCtx);
  let shared = 0;
  const r = new Set(refCtx);
  for (const w of r) if (t.has(w)) shared++;
  return shared / r.size;
}

// ---- geometry helpers ----

function verticalOverlap(a, b) {
  const top = Math.max(a.top, b.top);
  const bottom = Math.min(a.top + a.height, b.top + b.height);
  return Math.max(0, bottom - top);
}

function unionOfRects(rects) {
  let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity;
  for (const r of rects) {
    left = Math.min(left, r.left);
    top = Math.min(top, r.top);
    right = Math.max(right, r.left + r.width);
    bottom = Math.max(bottom, r.top + r.height);
  }
  return { left, top, width: right - left, height: bottom - top };
}

// rough position of a word inside its line box, proportional to the char offsets.
// not pixel perfect but good enough, we refine later with a real text search
function estTokenRect(tok) {
  const line = tok.line;
  const len = Math.max(line.contents.length, 1);
  const left = line.bbox.left + line.bbox.width * (tok.charStart / len);
  const right = line.bbox.left + line.bbox.width * (tok.charEnd / len);
  return { left, top: line.bbox.top, width: right - left, height: line.bbox.height };
}

// ---- document index ----

// reads the whole document and builds the word index: every word with its page, line
// and char range, plus a trigram map (3 words sequences) to find candidates quickly
export async function buildDocIndex(instance, onProgress) {
  const total = instance.totalPageCount;
  const pages = [];
  const mTokens = [];

  for (let p = 0; p < total; p++) {
    const rawLines = toArray(await instance.textLinesForPageIndex(p));
    const lines = [];
    const mStart = mTokens.length;

    rawLines.forEach((tl, lineIdx) => {
      const contents = tl.contents || "";
      const lineRec = {
        pageIndex: p,
        lineIdx,
        contents,
        bbox: tl.boundingBox,
        mStart: mTokens.length,
        mEnd: mTokens.length,
      };
      const re = /\S+/g;
      let m;
      while ((m = re.exec(contents))) {
        const norm = normWord(m[0]);
        if (!norm) continue;
        mTokens.push({
          norm,
          raw: m[0],
          pageIndex: p,
          line: lineRec,
          charStart: m.index,
          charEnd: m.index + m[0].length,
          idx: mTokens.length,
        });
      }
      lineRec.mEnd = mTokens.length;
      lines.push(lineRec);
    });

    pages.push({
      pageIndex: p,
      lines,
      text: lines.map((l) => l.contents).join(" "),
      mStart,
      mEnd: mTokens.length,
    });
    if (onProgress) onProgress(p + 1, total);
  }

  const trigrams = new Map();
  for (let i = 0; i + 2 < mTokens.length; i++) {
    const key = mTokens[i].norm + SEP + mTokens[i + 1].norm + SEP + mTokens[i + 2].norm;
    let arr = trigrams.get(key);
    if (!arr) trigrams.set(key, (arr = []));
    if (arr.length < 64) arr.push(i);
  }

  const freq = new Map();
  for (const t of mTokens) freq.set(t.norm, (freq.get(t.norm) || 0) + 1);

  return { pages, mTokens, trigrams, freq, instance };
}

// ---- anchoring (reference side) ----

// words that sit under the highlight rects
function tokensUnderRects(page, rects) {
  const found = [];
  for (const line of page.lines) {
    // skip lines that are not even at the same height
    if (!rects.some((r) => verticalOverlap(line.bbox, r) > 0)) continue;
    for (let i = line.mStart; i < line.mEnd; i++) {
      const tokRect = estTokenRect(pageTokens(page)[i - page.mStart]);
      for (const r of rects) {
        const vo = verticalOverlap(tokRect, r);
        if (vo < 0.5 * Math.min(tokRect.height, r.height)) continue;
        const ho =
          Math.min(tokRect.left + tokRect.width, r.left + r.width) -
          Math.max(tokRect.left, r.left);
        if (ho >= 0.4 * tokRect.width) {
          found.push(i);
          break;
        }
      }
    }
  }
  return found;
}

// small cache so we don't re-slice the token array all the time
const pageTokenCache = new WeakMap();
let pageTokenCacheIndex = null;
function bindPageTokens(index) {
  pageTokenCacheIndex = index;
}
function pageTokens(page) {
  let slice = pageTokenCache.get(page);
  if (!slice) {
    slice = pageTokenCacheIndex.mTokens.slice(page.mStart, page.mEnd);
    pageTokenCache.set(page, slice);
  }
  return slice;
}

// words that are inside a shape. we shrink the box by half the stroke width first,
// otherwise a thick border catches words from the line just below the box
function tokensInsideBbox(page, bbox, inset = 1) {
  const region = {
    left: bbox.left + inset,
    top: bbox.top + inset,
    width: Math.max(0, bbox.width - inset * 2),
    height: Math.max(0, bbox.height - inset * 2),
  };
  const found = [];
  for (const line of page.lines) {
    if (verticalOverlap(line.bbox, region) <= 0) continue;
    for (let i = line.mStart; i < line.mEnd; i++) {
      const tr = estTokenRect(pageTokens(page)[i - page.mStart]);
      const vo = verticalOverlap(tr, region);
      const ho =
        Math.min(tr.left + tr.width, region.left + region.width) -
        Math.max(tr.left, region.left);
      if (vo >= 0.6 * tr.height && ho >= 0.6 * tr.width) found.push(i);
    }
  }
  return found;
}

// tells apart a circle from an arrow. a circle ends near where it started, or its path
// is way longer than the diagonal (a loop does ~2.5x the diagonal, an arrow ~1.5x max)
function isEnclosingInkStroke(annotation) {
  const lines = annotation.lines;
  if (!lines || lines.size === 0) return false;
  const firstLine = lines.get(0);
  const lastLine = lines.get(lines.size - 1);
  if (!firstLine.size || !lastLine.size) return false;

  const bbox = annotation.boundingBox;
  const diag = Math.hypot(bbox.width, bbox.height) || 1;

  const a = firstLine.get(0);
  const b = lastLine.get(lastLine.size - 1);
  if (Math.hypot(a.x - b.x, a.y - b.y) < 0.3 * diag) return true;

  let pathLength = 0;
  lines.forEach((stroke) => {
    for (let i = 1; i < stroke.size; i++) {
      const p = stroke.get(i - 1);
      const q = stroke.get(i);
      pathLength += Math.hypot(q.x - p.x, q.y - p.y);
    }
  });
  return pathLength / diag > 2.2;
}

// find the tip of an arrow. people draw from the tail so the tip is the point the most
// far from the start (works also when the head is drawn as a second stroke). then we
// project a bit further in the pointing direction, because an arrow points BEYOND its tip
function inkStrokeTip(annotation) {
  const lines = annotation.lines;
  if (!lines || lines.size === 0) return null;
  const all = [];
  lines.forEach((s) => s.forEach((p) => all.push({ x: p.x, y: p.y })));
  if (all.length === 0) return null;

  const tail = all[0];
  let tip = all[0];
  let maxD = -1;
  let cx = 0, cy = 0;
  for (const p of all) {
    cx += p.x; cy += p.y;
    const d = Math.hypot(p.x - tail.x, p.y - tail.y);
    if (d > maxD) { maxD = d; tip = p; }
  }
  cx /= all.length;
  cy /= all.length;

  const dx = tip.x - cx;
  const dy = tip.y - cy;
  const len = Math.hypot(dx, dy);
  const ext = len > 1
    ? { x: tip.x + (dx / len) * 15, y: tip.y + (dy / len) * 15 }
    : { x: tip.x, y: tip.y };
  return { tip, ext };
}

// the few words the closest to a point. this is what an arrow really designates,
// anchoring to the whole line is not enough when the word moves inside the line
function tokensNearPoint(page, pt, maxDist = 40) {
  let best = null;
  let bestDist = Infinity;
  for (const line of page.lines) {
    for (let i = line.mStart; i < line.mEnd; i++) {
      const tr = estTokenRect(pageTokens(page)[i - page.mStart]);
      const dx = Math.max(0, Math.max(tr.left - pt.x, pt.x - (tr.left + tr.width)));
      const dy = Math.max(0, Math.max(tr.top - pt.y, pt.y - (tr.top + tr.height)));
      const dist = Math.hypot(dx, dy);
      if (dist < bestDist) { bestDist = dist; best = { idx: i, line }; }
    }
  }
  if (!best || bestDist > maxDist) return null;
  // take the word plus 2 neighbours each side, staying on the same line
  const start = Math.max(best.line.mStart, best.idx - 2);
  const end = Math.min(best.line.mEnd - 1, best.idx + 2);
  return { start, end };
}

// an open stroke drawn WITH a highlighter runs through the words themselves (flat band
// over 1-2 lines of text). that's not an arrow even if the stroke is open: it must be
// treated like a shape enclosing its words. we check that the path really crosses
// enough of the words sitting in the bbox
function isMarkerStroke(page, annotation) {
  const bbox = annotation.boundingBox;
  if (!bbox || bbox.height > 45) return false;
  const strokeW = annotation.lineWidth || annotation.strokeWidth || 2;
  const inset = Math.min(strokeW / 2 + 1, bbox.width / 4, bbox.height / 4);
  const inside = tokensInsideBbox(page, bbox, inset);
  if (inside.length < 6) return false;

  const pts = [];
  annotation.lines.forEach((s) => s.forEach((p) => pts.push(p)));
  const thr = strokeW / 2 + 4;
  let onPath = 0;
  for (const idx of inside) {
    const tr = estTokenRect(pageTokens(page)[idx - page.mStart]);
    const hit = pts.some((p) =>
      p.x >= tr.left - 2 && p.x <= tr.left + tr.width + 2 &&
      p.y >= tr.top - thr && p.y <= tr.top + tr.height + thr
    );
    if (hit) onPath++;
  }
  return onPath / inside.length >= 0.5;
}

// words really crossed by the stroke path, for highlighter bands. this is what the
// user visually painted over, much more precise than everything inside the bbox
// (a 2 lines band has a bbox that touches the lines above and below too)
function tokensOnStrokePath(page, annotation) {
  const bbox = annotation.boundingBox;
  const pts = [];
  annotation.lines.forEach((s) => s.forEach((p) => pts.push(p)));
  const strokeW = annotation.lineWidth || annotation.strokeWidth || 2;
  // a word counts as painted when the band of the stroke covers its CENTER. using the
  // full word height here would leak onto the line above/below with thick strokes
  const thr = strokeW / 2 + 2;
  const found = [];
  for (const line of page.lines) {
    if (verticalOverlap(line.bbox, bbox) <= 0) continue;
    for (let i = line.mStart; i < line.mEnd; i++) {
      const tr = estTokenRect(pageTokens(page)[i - page.mStart]);
      const cy = tr.top + tr.height / 2;
      const hit = pts.some((p) =>
        p.x >= tr.left - 2 && p.x <= tr.left + tr.width + 2 &&
        Math.abs(p.y - cy) <= thr
      );
      if (hit) found.push(i);
    }
  }
  return found;
}

// first drawn point of an ink stroke = the tail of an arrow
function inkStrokeTail(annotation) {
  const lines = annotation.lines;
  if (!lines || lines.size === 0) return null;
  const first = lines.get(0);
  if (!first.size) return null;
  const p = first.get(0);
  return { x: p.x, y: p.y };
}

// distance between a point and a rectangle (0 when inside)
function pointRectDist(pt, r) {
  const dx = Math.max(0, Math.max(r.left - pt.x, pt.x - (r.left + r.width)));
  const dy = Math.max(0, Math.max(r.top - pt.y, pt.y - (r.top + r.height)));
  return Math.hypot(dx, dy);
}

// closest text line to a point, null if too far
function nearestLineToPoint(page, pt, maxDist = 60) {
  let best = null;
  let bestDist = Infinity;
  for (const line of page.lines) {
    if (line.mEnd === line.mStart) continue;
    const lb = line.bbox;
    const dx = Math.max(0, Math.max(lb.left - pt.x, pt.x - (lb.left + lb.width)));
    const dy = Math.max(0, Math.max(lb.top - pt.y, pt.y - (lb.top + lb.height)));
    const dist = Math.hypot(dx, dy);
    if (dist < bestDist) { bestDist = dist; best = line; }
  }
  return bestDist <= maxDist ? best : null;
}

// closest text line to a box, null if too far
function nearestLine(page, bbox, maxDist = 150) {
  let best = null;
  let bestDist = Infinity;
  for (const line of page.lines) {
    if (line.mEnd === line.mStart) continue;
    const lb = line.bbox;
    const vGap = Math.max(0, Math.max(bbox.top - (lb.top + lb.height), lb.top - (bbox.top + bbox.height)));
    const hGap = Math.max(0, Math.max(bbox.left - (lb.left + lb.width), lb.left - (bbox.left + bbox.width)));
    const dist = vGap + 0.3 * hGap;
    if (dist < bestDist) {
      bestDist = dist;
      best = line;
    }
  }
  return bestDist <= maxDist ? best : null;
}

const CTX_WINDOW = 12;

// build the anchor from a token range: the words themselves + 12 words of context on
// each side, and the bounding box of the words in the reference
function buildAnchorFromSpan(refIndex, spanStart, spanEnd) {
  const toks = refIndex.mTokens;
  const anchorNorms = [];
  for (let i = spanStart; i <= spanEnd; i++) anchorNorms.push(toks[i].norm);
  const ctxBefore = [];
  for (let i = Math.max(0, spanStart - CTX_WINDOW); i < spanStart; i++) ctxBefore.push(toks[i].norm);
  const ctxAfter = [];
  for (let i = spanEnd + 1; i <= Math.min(toks.length - 1, spanEnd + CTX_WINDOW); i++) ctxAfter.push(toks[i].norm);
  const spanRects = [];
  for (let i = spanStart; i <= spanEnd; i++) spanRects.push(estTokenRect(toks[i]));
  return {
    anchorNorms,
    ctxBefore,
    ctxAfter,
    refSpanBbox: unionOfRects(spanRects),
    displayText: toks.slice(spanStart, spanEnd + 1).map((t) => t.raw).join(" "),
  };
}

// a note/free text is often placed in a margin, one single line next to it is a weak
// anchor. we grab a small block instead: the nearest line plus the 2 lines under it
// (if they are close), so the matcher has more words to find the right spot again
function blockAnchor(refIndex, page, bbox) {
  const first = nearestLine(page, bbox);
  if (!first || first.mEnd === first.mStart) return null;
  const lines = [first];
  let prev = first;
  for (const line of page.lines) {
    if (lines.length >= 3) break;
    if (line.lineIdx <= prev.lineIdx || line.mEnd === line.mStart) continue;
    const gap = line.bbox.top - (prev.bbox.top + prev.bbox.height);
    if (gap >= 0 && gap <= 25) { lines.push(line); prev = line; }
  }
  const anchor = buildAnchorFromSpan(refIndex, lines[0].mStart, lines[lines.length - 1].mEnd - 1);
  return { anchor, rect: unionOfRects(lines.map((l) => l.bbox)) };
}

// goes through all annotations of the reference and decides how each one is attached
// to the text:
//   - markup (highlight etc): the words under its rects
//   - shape/circle with words inside: "enclose", we will rebuild it around those words
//   - arrows: the words next to the tip
//   - notes / free text: a small block of nearby text. and if the text sits at the tail
//     of an arrow (classic "arrow + comment" combo), it reuses the arrow anchor so
//     both travel together
export async function extractAnnotationData(instance, refIndex, onProgress) {
  bindPageTokens(refIndex);
  const total = instance.totalPageCount;
  const results = [];

  for (let pageIndex = 0; pageIndex < total; pageIndex++) {
    const page = refIndex.pages[pageIndex];
    const annotations = await instance.getAnnotations(pageIndex);

    const annList = [];
    for (const annotation of annotations) {
      const annotType = getAnnotationType(annotation);
      if (annotType === "pspdfkit/widget") continue;
      annList.push({ annotation, annotType });
    }

    // first pass: work out the arrows, the labels next to them will need their anchor
    const arrows = [];
    if (page) {
      for (const item of annList) {
        if (item.annotType !== "pspdfkit/ink") continue;
        if (isEnclosingInkStroke(item.annotation)) continue; // closed stroke, not an arrow
        if (isMarkerStroke(page, item.annotation)) continue;  // highlighter band, not an arrow
        const tipInfo = inkStrokeTip(item.annotation);
        if (!tipInfo) continue;
        // words right under the tip first, then a bit beyond it (arrows point past
        // their tip), then a wider net around the tip
        const span = tokensNearPoint(page, tipInfo.tip, 25) ||
                     tokensNearPoint(page, tipInfo.ext, 40) ||
                     tokensNearPoint(page, tipInfo.tip, 60);
        if (!span) continue;
        const anchor = buildAnchorFromSpan(refIndex, span.start, span.end);
        item._arrowAnchor = { anchor, rect: anchor.refSpanBbox };
        arrows.push({ item, tail: inkStrokeTail(item.annotation) });
      }
    }

    for (const { annotation, annotType, _arrowAnchor } of annList) {
      const pageInfo = instance.pageInfoForIndex(pageIndex);
      const base = {
        annotation,
        annotType,
        refPageIndex: pageIndex,
        refPageText: page ? page.text : "",
        refPageSize: pageInfo
          ? { width: pageInfo.width, height: pageInfo.height }
          : { width: 612, height: 792 },
      };

      let mode = "page";
      let anchor = null;
      let refAnchorRect = null;

      if (page) {
        if (TEXT_MARKUP_TYPES.has(annotType) && annotation.rects && annotation.rects.size > 0) {
          const rects = toArray(annotation.rects);
          const hit = tokensUnderRects(page, rects);
          if (hit.length > 0) {
            mode = "markup";
            anchor = buildAnchorFromSpan(refIndex, Math.min(...hit), Math.max(...hit));
          }
        } else if (_arrowAnchor) {
          // arrow: follow the words its tip points to
          mode = "line-offset";
          anchor = _arrowAnchor.anchor;
          refAnchorRect = _arrowAnchor.rect;
        } else if (annotation.boundingBox) {
          const bbox = annotation.boundingBox;

          const isMarker = annotType === "pspdfkit/ink" && isMarkerStroke(page, annotation);
          const isArrow = annotType === "pspdfkit/ink" &&
            !isEnclosingInkStroke(annotation) &&
            !isMarker;

          // shrink by half the stroke width (capped, a fat marker dot is all stroke)
          const strokeW = annotation.lineWidth || annotation.strokeWidth || 2;
          const inset = Math.min(strokeW / 2 + 1, bbox.width / 4, bbox.height / 4);
          const inside = !isArrow && !isMarker && ENCLOSABLE_TYPES.has(annotType)
            ? tokensInsideBbox(page, bbox, inset)
            : [];

          const painted = isMarker ? tokensOnStrokePath(page, annotation) : [];

          if (painted.length > 0) {
            // highlighter band: behaves like a text highlight, anchored to the exact
            // words the stroke was painted over
            mode = "marker";
            anchor = buildAnchorFromSpan(refIndex, Math.min(...painted), Math.max(...painted));
          } else if (inside.length >= MIN_ENCLOSE_TOKENS) {
            mode = "enclose";
            anchor = buildAnchorFromSpan(refIndex, Math.min(...inside), Math.max(...inside));
          } else {
            // is this text the label of an arrow? (tail of the arrow next to the box)
            let paired = null;
            if (annotType === "pspdfkit/text" || annotType === "pspdfkit/note") {
              for (const a of arrows) {
                if (a.tail && a.item._arrowAnchor && pointRectDist(a.tail, bbox) <= 80) {
                  paired = a.item._arrowAnchor;
                  break;
                }
              }
            }
            if (paired) {
              mode = "line-offset";
              anchor = paired.anchor;
              refAnchorRect = paired.rect;
            } else {
              const block = blockAnchor(refIndex, page, bbox);
              if (block) {
                mode = "line-offset";
                anchor = block.anchor;
                refAnchorRect = block.rect;
              }
            }
          }
        }
      }

      results.push({
        ...base,
        mode,
        anchorNorms: anchor ? anchor.anchorNorms : [],
        ctxBefore: anchor ? anchor.ctxBefore : [],
        ctxAfter: anchor ? anchor.ctxAfter : [],
        refSpanBbox: anchor ? anchor.refSpanBbox : null,
        refAnchorRect,
        anchorText: anchor ? anchor.displayText : "",
      });
    }

    if (onProgress) onProgress(pageIndex + 1, total);
  }

  return results;
}

// ---- page matching ----

// use to find on which page of the target the ref page probably went. only a hint,
// the real decision is made by the word alignment
function findBestMatchingPage(refPageText, targetPages, threshold = 0.4) {
  let best = null;
  let bestScore = 0;
  for (const page of targetPages) {
    const score = wordOverlapRatio(refPageText, page.text);
    if (score > bestScore) { bestScore = score; best = page.pageIndex; }
  }
  if (best !== null && bestScore >= threshold) {
    return { targetPageIndex: best, similarity: bestScore };
  }
  return null;
}

// ---- fuzzy matching ----

// local alignment (Smith-Waterman style) between the anchor words and a window of
// target words. a match earns points, every skipped word costs a little. that's the
// important part: with a plain LCS, words like "the" or "budget" could match
// again 30 words further in the NEXT sentence and drag the span way too far. with
// gap penalties, a far away match is just not worth its cost, so the span stays on
// the dense zone that really corresponds to the anchor
function lcsAlign(anchor, windowNorms) {
  const n = anchor.length;
  const m = windowNorms.length;
  if (!n || !m) return { count: 0 };

  const MATCH = 8;
  const GAP = 1;
  const SUB = 2;

  const dp = [];
  for (let i = 0; i <= n; i++) dp.push(new Int16Array(m + 1));
  let bi = 0, bj = 0, bestScore = 0;
  for (let i = 1; i <= n; i++) {
    const ai = anchor[i - 1];
    const prev = dp[i - 1];
    const cur = dp[i];
    for (let j = 1; j <= m; j++) {
      let v = prev[j - 1] + (ai === windowNorms[j - 1] ? MATCH : -SUB);
      if (prev[j] - GAP > v) v = prev[j] - GAP;
      if (cur[j - 1] - GAP > v) v = cur[j - 1] - GAP;
      if (v < 0) v = 0;
      cur[j] = v;
      if (v > bestScore) { bestScore = v; bi = i; bj = j; }
    }
  }
  if (bestScore === 0) return { count: 0 };

  const matched = [];
  let i = bi, j = bj;
  while (i > 0 && j > 0 && dp[i][j] > 0) {
    const v = dp[i][j];
    if (anchor[i - 1] === windowNorms[j - 1] && v === dp[i - 1][j - 1] + MATCH) {
      matched.push(j - 1);
      i--; j--;
    } else if (v === dp[i - 1][j] - GAP) {
      i--;
    } else if (v === dp[i][j - 1] - GAP) {
      j--;
    } else if (v === dp[i - 1][j - 1] - SUB) {
      i--; j--;
    } else {
      break;
    }
  }
  matched.reverse();

  // don't let the span start/end on a lonely small word, that's never the real border
  const weak = (w) => w.length <= 3;
  while (matched.length > 1 && weak(windowNorms[matched[0]]) && matched[1] - matched[0] > 1) matched.shift();
  while (matched.length > 1 && weak(windowNorms[matched[matched.length - 1]]) && matched[matched.length - 1] - matched[matched.length - 2] > 1) matched.pop();

  if (matched.length === 0) return { count: 0 };
  return { count: matched.length, firstIdx: matched[0], lastIdx: matched[matched.length - 1] };
}

// use to find where the anchor could be in the target. trigram votes give us candidate
// positions fast. candidates on the expected page are always kept even past the cap,
// important for one word anchors like a city name that appears 30 times in the doc
function candidateStarts(anchorNorms, targetIndex, preferredRange) {
  const votes = new Map();
  const n = anchorNorms.length;

  if (n >= 3) {
    for (let j = 0; j + 2 < n; j++) {
      const key = anchorNorms[j] + SEP + anchorNorms[j + 1] + SEP + anchorNorms[j + 2];
      const hits = targetIndex.trigrams.get(key);
      if (!hits) continue;
      for (const h of hits) {
        const s = Math.max(0, h - j);
        votes.set(s, (votes.get(s) || 0) + 1);
      }
    }
  }

  // no trigram matched (short anchor or text too edited), fallback on the rarest word
  if (votes.size === 0) {
    let best = null;
    for (let j = 0; j < n; j++) {
      const f = targetIndex.freq.get(anchorNorms[j]) || 0;
      if (f > 0 && (!best || f < best.f)) best = { j, f, norm: anchorNorms[j] };
    }
    if (best && best.f <= 500) {
      for (let i = 0; i < targetIndex.mTokens.length; i++) {
        if (targetIndex.mTokens[i].norm === best.norm) {
          const s = Math.max(0, i - best.j);
          votes.set(s, (votes.get(s) || 0) + 1);
        }
      }
    }
  }

  // group starts that are next to each other and keep the strongest ones
  const sorted = [...votes.entries()].sort((a, b) => a[0] - b[0]);
  const clusters = [];
  for (const [s, v] of sorted) {
    const last = clusters[clusters.length - 1];
    if (last && s - last.end <= 2) { last.votes += v; last.end = s; }
    else clusters.push({ start: s, end: s, votes: v });
  }
  clusters.sort((a, b) => b.votes - a.votes);

  const kept = new Set(clusters.slice(0, 10).map((c) => c.start));
  if (preferredRange) {
    let extra = 0;
    for (const c of clusters) {
      if (extra >= 20) break;
      if (c.start >= preferredRange.start && c.start < preferredRange.end && !kept.has(c.start)) {
        kept.add(c.start);
        extra++;
      }
    }
  }
  return [...kept];
}

const MAX_ANCHOR_TOKENS = 300;

// score every candidate and return the best span. score = how much words matched
// + how similar the surrounding is + a small bonus if it's on the expected page.
// the context part is what picks the right occurrence when the same text exists twice
function findBestSpan(data, targetIndex, pageMatch) {
  let anchor = data.anchorNorms;
  if (anchor.length === 0) return null;
  if (anchor.length > MAX_ANCHOR_TOKENS) {
    anchor = anchor.slice(0, MAX_ANCHOR_TOKENS / 2).concat(anchor.slice(-MAX_ANCHOR_TOKENS / 2));
  }
  const n = anchor.length;
  const toks = targetIndex.mTokens;

  let preferredRange = null;
  if (pageMatch) {
    const pg = targetIndex.pages[pageMatch.targetPageIndex];
    if (pg) preferredRange = { start: pg.mStart, end: pg.mEnd };
  }
  const starts = candidateStarts(anchor, targetIndex, preferredRange);
  if (starts.length === 0) return null;

  const minAlignment = n >= 3 ? 0.45 : 1.0;
  let best = null;
  let runnerUp = null;
  let bestOnMatchedPage = null;

  for (const s of starts) {
    // start the window a few words before the vote. if words got inserted at the
    // beginning ("strongly recommends...") the vote points after the real start
    const wStart = Math.max(0, s - 6);
    const wLen = Math.min(Math.ceil(n * 1.6) + 12, toks.length - wStart);
    if (wLen <= 0) continue;
    const windowNorms = [];
    for (let i = wStart; i < wStart + wLen; i++) windowNorms.push(toks[i].norm);

    const aligned = lcsAlign(anchor, windowNorms);
    if (!aligned.count) continue;
    const alignment = aligned.count / n;
    if (alignment < minAlignment) continue;

    const spanStart = wStart + aligned.firstIdx;
    const spanEnd = wStart + aligned.lastIdx;

    const before = [];
    for (let i = Math.max(0, spanStart - CTX_WINDOW); i < spanStart; i++) before.push(toks[i].norm);
    const after = [];
    for (let i = spanEnd + 1; i <= Math.min(toks.length - 1, spanEnd + CTX_WINDOW); i++) after.push(toks[i].norm);
    const context = (ctxOverlap(data.ctxBefore, before) + ctxOverlap(data.ctxAfter, after)) / 2;

    const spanPage = toks[spanStart].pageIndex;
    const pagePrior = pageMatch && spanPage === pageMatch.targetPageIndex ? pageMatch.similarity : 0;

    const score = 0.5 * alignment + 0.3 * context + 0.2 * pagePrior;
    const entry = { spanStart, spanEnd, score, alignment, context, pagePrior, pageIndex: spanPage };
    if (!best || score > best.score) {
      if (best && Math.abs(best.spanStart - entry.spanStart) > 3) runnerUp = best;
      best = entry;
    } else if (
      Math.abs(entry.spanStart - best.spanStart) > 3 &&
      (!runnerUp || entry.score > runnerUp.score)
    ) {
      runnerUp = entry;
    }
    if (pageMatch && spanPage === pageMatch.targetPageIndex &&
        (!bestOnMatchedPage || score > bestOnMatchedPage.score)) {
      bestOnMatchedPage = entry;
    }
  }

  if (best) {
    best.runnerUp = runnerUp;
    best.bestOnMatchedPage = bestOnMatchedPage;
  }
  return best;
}

// ---- span to rectangles ----

// turn the matched words into rects, line by line. we try a real SDK text search on
// each line substring to get exact glyph rects, and keep the estimation as fallback
async function spanToPageRects(targetInstance, targetIndex, spanStart, spanEnd) {
  const toks = targetIndex.mTokens;
  const NutrientViewer = NV();

  // group the span words by line
  const lineGroups = [];
  for (let i = spanStart; i <= spanEnd; i++) {
    const tok = toks[i];
    const last = lineGroups[lineGroups.length - 1];
    if (last && last.line === tok.line) last.last = tok;
    else lineGroups.push({ line: tok.line, first: tok, last: tok });
  }

  const pageRects = new Map();
  for (const g of lineGroups) {
    const { line, first, last } = g;
    const estLeft = estTokenRect(first).left;
    const estRight = (() => { const r = estTokenRect(last); return r.left + r.width; })();
    let rect = {
      left: estLeft,
      top: line.bbox.top,
      width: Math.max(estRight - estLeft, 2),
      height: line.bbox.height,
    };

    const substr = line.contents.slice(first.charStart, last.charEnd).trim();
    if (substr.length >= 3 && substr.length <= 190) {
      try {
        const found = toArray(await targetInstance.search(substr));
        // only keep results that are really on this line
        const onLine = found.filter((r) =>
          r.pageIndex === line.pageIndex &&
          verticalOverlap(NutrientViewer.Geometry.Rect.union(r.rectsOnPage), line.bbox) >=
            0.5 * line.bbox.height
        );
        if (onLine.length > 0) {
          const bestHit = onLine.reduce((a, b) => {
            const ua = NutrientViewer.Geometry.Rect.union(a.rectsOnPage);
            const ub = NutrientViewer.Geometry.Rect.union(b.rectsOnPage);
            return Math.abs(ua.left - estLeft) <= Math.abs(ub.left - estLeft) ? a : b;
          });
          const u = NutrientViewer.Geometry.Rect.union(bestHit.rectsOnPage);
          rect = { left: u.left, top: u.top, width: u.width, height: u.height };
        }
      } catch (_) {}
    }

    let arr = pageRects.get(line.pageIndex);
    if (!arr) pageRects.set(line.pageIndex, (arr = []));
    arr.push(rect);
  }

  return [...pageRects.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([pageIndex, rects]) => ({ pageIndex, rects }));
}

// ---- placement ----

function toRectList(rects) {
  const NutrientViewer = NV();
  return NutrientViewer.Immutable.List(
    rects.map((r) => new NutrientViewer.Geometry.Rect(r))
  );
}

function pageScale(refPageSize, targetInstance, targetPageIndex) {
  const info = targetInstance.pageInfoForIndex(targetPageIndex) || { width: 612, height: 792 };
  return {
    x: info.width / (refPageSize.width || info.width),
    y: info.height / (refPageSize.height || info.height),
  };
}

// keep the placed annotation inside the page, a big offset from a moved anchor can
// push it out of the sheet otherwise
function clampToPage(rect, targetInstance, targetPageIndex) {
  const info = targetInstance.pageInfoForIndex(targetPageIndex);
  if (!info) return rect;
  const left = Math.min(Math.max(rect.left, 2), Math.max(2, info.width - rect.width - 2));
  const top = Math.min(Math.max(rect.top, 2), Math.max(2, info.height - rect.height - 2));
  return { left, top, width: rect.width, height: rect.height };
}

// put the annotation at the same distance from its anchor as in the reference
function buildOffsetResult(annotation, refAnchorRect, targetAnchorRect, targetPageIndex,
                           refPageSize, targetInstance) {
  const NutrientViewer = NV();
  const s = pageScale(refPageSize, targetInstance, targetPageIndex);
  const bbox = annotation.boundingBox;

  let raw;
  if (refAnchorRect && targetAnchorRect) {
    const dx = bbox.left - refAnchorRect.left;
    const dy = bbox.top - refAnchorRect.top;
    raw = {
      left: targetAnchorRect.left + dx * s.x,
      top: targetAnchorRect.top + dy * s.y,
      width: bbox.width * s.x,
      height: bbox.height * s.y,
    };
  } else {
    // no anchor at all, just scale the page coordinates
    raw = {
      left: bbox.left * s.x,
      top: bbox.top * s.y,
      width: bbox.width * s.x,
      height: bbox.height * s.y,
    };
  }

  const newRect = new NutrientViewer.Geometry.Rect(clampToPage(raw, targetInstance, targetPageIndex));
  return {
    pageIndex: targetPageIndex,
    rectsOnPage: NutrientViewer.Immutable.List([newRect]),
  };
}

function buildPagePositionResult(annotation, refPageSize, targetPageIndex, targetInstance) {
  return buildOffsetResult(annotation, null, null, targetPageIndex, refPageSize, targetInstance);
}

// place a shape by keeping its geometry RELATIVE to its text block: same position and
// same size proportions vs the block, applied on the block's new bbox. so if the block
// didn't change the shape stays identical, if the block lost a sentence the shape
// shrinks with it, and a circle covering the left third of a list keeps covering the
// left third. scaling is capped so a crazy reflow cannot distort the drawing too much
function buildFractionalResult(annotation, refSpanBbox, targetSpanBbox, targetPageIndex,
                               refPageSize, targetInstance) {
  const NutrientViewer = NV();
  const s = pageScale(refPageSize, targetInstance, targetPageIndex);
  const bbox = annotation.boundingBox;

  const rw = Math.max(refSpanBbox.width, 2);
  const rh = Math.max(refSpanBbox.height, 2);
  const cap = (v) => Math.min(2.5, Math.max(0.4, v));
  const sx = cap(targetSpanBbox.width / rw) * s.x;
  const sy = cap(targetSpanBbox.height / rh) * s.y;

  const raw = {
    left: targetSpanBbox.left + (bbox.left - refSpanBbox.left) * sx,
    top: targetSpanBbox.top + (bbox.top - refSpanBbox.top) * sy,
    width: Math.max(bbox.width * sx, 4),
    height: Math.max(bbox.height * sy, 4),
  };

  const newRect = new NutrientViewer.Geometry.Rect(clampToPage(raw, targetInstance, targetPageIndex));
  return {
    pageIndex: targetPageIndex,
    rectsOnPage: NutrientViewer.Immutable.List([newRect]),
  };
}

// ---- matching ----

async function matchAnnotation(data, targetInstance, targetIndex) {
  const { annotType, mode, refPageIndex, refPageSize } = data;
  const pageMatch = findBestMatchingPage(data.refPageText, targetIndex.pages);

  const dbg = `[AM p${refPageIndex}][${annotType.split("/").pop()}][${mode}]`;
  console.log(dbg, "anchor:", JSON.stringify((data.anchorText || "").slice(0, 70)),
    `(${data.anchorNorms.length} words)`);

  if (mode !== "page") {
    let best = findBestSpan(data, targetIndex, pageMatch);

    // special case for repeated boilerplate (headers, footers...): if the two best
    // candidates are on different pages with almost the same score, the anchor text
    // exists everywhere. take the occurrence on the expected page if there is one,
    // otherwise the original text is probably gone and we fallback to page position
    if (
      best && best.runnerUp &&
      best.runnerUp.pageIndex !== best.pageIndex &&
      best.score - best.runnerUp.score < 0.05 &&
      best.pagePrior === 0 &&
      pageMatch
    ) {
      if (best.bestOnMatchedPage) {
        console.log(dbg, `ambiguous span -> using candidate on expected page p${best.bestOnMatchedPage.pageIndex}`);
        best = best.bestOnMatchedPage;
      } else {
        console.log(dbg, `ambiguous span (best ${best.score.toFixed(2)} on p${best.pageIndex}`,
          `vs ${best.runnerUp.score.toFixed(2)} on p${best.runnerUp.pageIndex}) -> page fallback`);
        best = null;
      }
    }

    if (best) {
      const spanPage = targetIndex.mTokens[best.spanStart].pageIndex;
      console.log(
        dbg,
        `matched span p${spanPage} tokens ${best.spanStart}-${best.spanEnd}`,
        `(score ${best.score.toFixed(2)}: align ${best.alignment.toFixed(2)},`,
        `ctx ${best.context.toFixed(2)}, page ${best.pagePrior.toFixed(2)})`
      );

      // snap the end of a highlight to the sentence: the painted band often grabs one
      // or two words of the next sentence on the same line ("... approved. Roof work"), we
      // cut right after the period instead
      if (mode === "markup" || mode === "marker") {
        const toks = targetIndex.mTokens;
        for (let i = best.spanEnd; i >= best.spanStart && i >= best.spanEnd - 3; i--) {
          if (/[.!?]["')\]]?$/.test(toks[i].raw)) {
            if (i < best.spanEnd) best.spanEnd = i;
            break;
          }
        }
      }

      const perPage = await spanToPageRects(targetInstance, targetIndex, best.spanStart, best.spanEnd);
      if (perPage.length > 0) {
        let chosenResult = null;

        if (mode === "markup" || mode === "marker") {
          // if the text reflowed over a page break we split into one annotation per page
          const isMarker = mode === "marker";
          const [first, ...rest] = perPage;
          chosenResult = {
            pageIndex: first.pageIndex,
            rectsOnPage: toRectList(first.rects),
            isMarker,
            extraPages: rest.map((p) => ({
              pageIndex: p.pageIndex,
              rectsOnPage: toRectList(p.rects),
              isMarker,
            })),
          };
          if (rest.length > 0) {
            console.log(dbg, `span reflowed across ${perPage.length} pages -> splitting markup`);
          }
        } else if (mode === "enclose") {
          // one shape per page: if the enclosed text got split by a page break, we
          // duplicate the drawing and wrap each fragment with its own copy
          const parts = perPage.map((p) => buildFractionalResult(
            data.annotation, data.refSpanBbox, unionOfRects(p.rects),
            p.pageIndex, refPageSize, targetInstance
          ));
          chosenResult = {
            pageIndex: parts[0].pageIndex,
            rectsOnPage: parts[0].rectsOnPage,
            extraPages: parts.slice(1).map((p) => ({
              pageIndex: p.pageIndex,
              rectsOnPage: p.rectsOnPage,
            })),
          };
          if (parts.length > 1) {
            console.log(dbg, `enclosed text split over ${parts.length} pages -> duplicating the shape`);
          }
        } else {
          // line-offset: take the page holding most of the span as the anchor
          const dominant = perPage.reduce((a, b) => (b.rects.length > a.rects.length ? b : a));
          const spanBbox = unionOfRects(dominant.rects);
          chosenResult = buildOffsetResult(
            data.annotation, data.refAnchorRect, spanBbox,
            dominant.pageIndex, refPageSize, targetInstance
          );
        }

        if (chosenResult) {
          return {
            annotationData: data, matched: true,
            chosenResult, pageMatch, confidence: best.score,
            fuzzy: best.alignment < 0.999,
          };
        }
      }
    } else {
      console.log(dbg, "no span matched -> falling back to page position");
    }
  }

  // last resort: same position on the matching page
  if (pageMatch) {
    console.log(dbg, "using page-position fallback");
    const chosenResult = buildPagePositionResult(
      data.annotation, refPageSize, pageMatch.targetPageIndex, targetInstance
    );
    return {
      annotationData: data, matched: true, chosenResult, pageMatch,
      confidence: pageMatch.similarity * 0.7, usedPageFallback: true,
    };
  }

  const reason = data.anchorNorms.length === 0
    ? "No usable anchor text and no matching page found"
    : "Text not found in target and no matching page found";
  return { annotationData: data, matched: false, reason };
}

export async function matchAllAnnotations(annotationDataList, targetInstance, targetIndex, onProgress) {
  bindPageTokens(targetIndex);
  const results = [];
  const total = annotationDataList.length;
  for (let i = 0; i < total; i++) {
    results.push(await matchAnnotation(annotationDataList[i], targetInstance, targetIndex));
    if (onProgress) onProgress(i + 1, total);
  }
  return results;
}

// ---- rebuild the annotations in the target ----

function buildNewAnnotation(originalAnnotation, annotType, chosenResult) {
  const NutrientViewer = NV();
  const Annotations = NutrientViewer.Annotations;
  const Geometry = NutrientViewer.Geometry;
  const targetPageIndex = chosenResult.pageIndex;

  const rectsOnPage = chosenResult.rectsOnPage;
  const firstRect = rectsOnPage && rectsOnPage.size > 0 ? rectsOnPage.get(0) : null;

  if (TEXT_MARKUP_TYPES.has(annotType)) {
    const unionR = rectsOnPage && rectsOnPage.size > 0
      ? Geometry.Rect.union(rectsOnPage) : firstRect;

    const baseProps = {
      pageIndex: targetPageIndex,
      rects: rectsOnPage,
      boundingBox: unionR,
      color: originalAnnotation.color,
      opacity: originalAnnotation.opacity,
      note: originalAnnotation.note || "",
    };

    if (annotType === "pspdfkit/highlight") {
      return new Annotations.HighlightAnnotation({
        ...baseProps, blendMode: originalAnnotation.blendMode || "multiply",
      });
    }
    if (annotType === "pspdfkit/underline")  return new Annotations.UnderlineAnnotation(baseProps);
    if (annotType === "pspdfkit/strikeout")  return new Annotations.StrikeOutAnnotation(baseProps);
    if (annotType === "pspdfkit/squiggle")   return new Annotations.SquiggleAnnotation(baseProps);
    if (annotType === "pspdfkit/redact") {
      try {
        return new Annotations.RedactionAnnotation({
          ...baseProps,
          fillColor: originalAnnotation.fillColor,
          overlayText: originalAnnotation.overlayText,
        });
      } catch (_) {}
    }
  }

  const scaledBbox = firstRect || originalAnnotation.boundingBox;
  if (!scaledBbox) return null;

  if (annotType === "pspdfkit/note") {
    return new Annotations.NoteAnnotation({
      pageIndex: targetPageIndex,
      boundingBox: scaledBbox,
      text: { format: "plain", value: originalAnnotation.text?.value || "" },
      icon: originalAnnotation.icon || "Comment",
      color: originalAnnotation.color,
      opacity: originalAnnotation.opacity,
    });
  }

  if (annotType === "pspdfkit/text") {
    return new Annotations.TextAnnotation({
      pageIndex: targetPageIndex,
      boundingBox: scaledBbox,
      text: originalAnnotation.text || { format: "plain", value: "" },
      fontSize: originalAnnotation.fontSize,
      fontColor: originalAnnotation.fontColor,
      backgroundColor: originalAnnotation.backgroundColor,
      opacity: originalAnnotation.opacity,
    });
  }

  // highlighter band: redrawn as one clean horizontal stroke per line of the matched
  // text, so it covers exactly the words it was painted over, like a real highlight
  if (annotType === "pspdfkit/ink" && chosenResult.isMarker && rectsOnPage && rectsOnPage.size > 0) {
    const rects = toArray(rectsOnPage);
    const bandW = rects.reduce((s, r) => s + r.height, 0) / rects.length;
    const strokes = rects.map((r) => {
      const cy = r.top + r.height / 2;
      return NutrientViewer.Immutable.List([
        new NutrientViewer.Geometry.DrawingPoint({ x: r.left, y: cy }),
        new NutrientViewer.Geometry.DrawingPoint({ x: r.left + r.width, y: cy }),
      ]);
    });
    const u = Geometry.Rect.union(rectsOnPage);
    try {
      return new Annotations.InkAnnotation({
        pageIndex: targetPageIndex,
        boundingBox: new Geometry.Rect({
          left: u.left - 2, top: u.top - 2, width: u.width + 4, height: u.height + 4,
        }),
        lines: NutrientViewer.Immutable.List(strokes),
        strokeColor: originalAnnotation.strokeColor,
        lineWidth: bandW,
        opacity: originalAnnotation.opacity,
        blendMode: originalAnnotation.blendMode,
      });
    } catch (_) {}
  }

  if (annotType === "pspdfkit/ink") {
    let lines = originalAnnotation.lines;
    const origBbox = originalAnnotation.boundingBox;

    // move/scale the stroke points into the new box. when the box has the same size
    // (the usual case now) this is just a translation, the drawing is not deformed
    if (lines && lines.size > 0 && origBbox && origBbox.width > 0 && origBbox.height > 0) {
      const scaleX = scaledBbox.width  / origBbox.width;
      const scaleY = scaledBbox.height / origBbox.height;
      const offsetX = scaledBbox.left - origBbox.left * scaleX;
      const offsetY = scaledBbox.top  - origBbox.top  * scaleY;

      lines = lines.map((line) =>
        line.map((pt) =>
          new NutrientViewer.Geometry.DrawingPoint({
            x: pt.x * scaleX + offsetX,
            y: pt.y * scaleY + offsetY,
          })
        )
      );
    }

    try {
      return new Annotations.InkAnnotation({
        pageIndex: targetPageIndex,
        boundingBox: scaledBbox,
        lines: lines || NutrientViewer.Immutable.List(),
        strokeColor: originalAnnotation.strokeColor,
        lineWidth: originalAnnotation.lineWidth || originalAnnotation.strokeWidth,
        opacity: originalAnnotation.opacity,
      });
    } catch (_) {}
  }

  const classMap = {
    "pspdfkit/shape/rectangle":  Annotations.RectangleAnnotation,
    "pspdfkit/shape/ellipse":    Annotations.EllipseAnnotation,
    "pspdfkit/shape/line":       Annotations.LineAnnotation,
    "pspdfkit/shape/polygon":    Annotations.PolygonAnnotation,
    "pspdfkit/shape/polyline":   Annotations.PolylineAnnotation,
  };

  const AnnotClass = classMap[annotType];
  if (AnnotClass) {
    try {
      return new AnnotClass({
        pageIndex: targetPageIndex,
        boundingBox: scaledBbox,
        strokeColor: originalAnnotation.strokeColor,
        fillColor: originalAnnotation.fillColor,
        strokeWidth: originalAnnotation.strokeWidth,
        opacity: originalAnnotation.opacity,
      });
    } catch (_) {}
  }

  return null;
}

export async function drawAnnotationsInTarget(matchResults, targetInstance) {
  const toCreate = [];
  for (const result of matchResults) {
    if (!result.matched || !result.chosenResult) continue;

    // a markup that reflowed over a page break is several annotations, one per page
    const parts = [result.chosenResult, ...(result.chosenResult.extraPages || [])];
    for (const part of parts) {
      const ann = buildNewAnnotation(
        result.annotationData.annotation,
        result.annotationData.annotType,
        part
      );
      if (ann) toCreate.push(ann);
    }
  }
  if (toCreate.length === 0) return 0;
  await targetInstance.create(toCreate);
  return toCreate.length;
}

// ---- labels for the results table ----

export function getAnnotationLabel(type) {
  const labels = {
    "pspdfkit/highlight":        "Highlight",
    "pspdfkit/underline":        "Underline",
    "pspdfkit/strikeout":        "Strikeout",
    "pspdfkit/squiggle":         "Squiggle",
    "pspdfkit/note":             "Note",
    "pspdfkit/text":             "Free Text",
    "pspdfkit/ink":              "Ink",
    "pspdfkit/shape/rectangle":  "Rectangle",
    "pspdfkit/shape/ellipse":    "Ellipse",
    "pspdfkit/shape/line":       "Line",
    "pspdfkit/image":            "Image",
    "pspdfkit/redact":           "Redaction",
    "pspdfkit/unknown":          "Unknown",
  };
  if (!type) return "Unknown";
  return labels[type] || type.replace("pspdfkit/", "");
}
