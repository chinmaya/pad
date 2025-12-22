(function () {
  function fnv1a32(input) {
    const text = typeof input === 'string' ? input : String(input ?? '');
    let hash = 0x811c9dc5;
    for (let i = 0; i < text.length; i += 1) {
      hash ^= text.charCodeAt(i);
      hash = (hash * 0x01000193) >>> 0;
    }
    return hash >>> 0;
  }

  function splitLines(text) {
    return String(text ?? '').split(/\r?\n/);
  }

  function linesEqual(a, b) {
    if (a.length !== b.length) {
      return false;
    }
    for (let i = 0; i < a.length; i += 1) {
      if (a[i] !== b[i]) {
        return false;
      }
    }
    return true;
  }

  function isSubsequence(candidate, sequence) {
    if (candidate.length === 0) {
      return true;
    }
    let i = 0;
    for (let j = 0; j < sequence.length; j += 1) {
      if (sequence[j] === candidate[i]) {
        i += 1;
        if (i === candidate.length) {
          return true;
        }
      }
    }
    return false;
  }

  function computeLcsPairs(aLines, bLines, maxCells) {
    const aLen = aLines.length;
    const bLen = bLines.length;
    const cellCount = aLen * bLen;
    if (cellCount > maxCells) {
      return null;
    }

    const dp = Array.from({ length: aLen + 1 }, () => new Uint32Array(bLen + 1));
    for (let i = 1; i <= aLen; i += 1) {
      const ai = aLines[i - 1];
      const row = dp[i];
      const prevRow = dp[i - 1];
      for (let j = 1; j <= bLen; j += 1) {
        if (ai === bLines[j - 1]) {
          row[j] = prevRow[j - 1] + 1;
        } else {
          const left = row[j - 1];
          const up = prevRow[j];
          row[j] = left > up ? left : up;
        }
      }
    }

    const pairs = [];
    let i = aLen;
    let j = bLen;
    while (i > 0 && j > 0) {
      if (aLines[i - 1] === bLines[j - 1]) {
        pairs.push([i - 1, j - 1]);
        i -= 1;
        j -= 1;
        continue;
      }

      if (dp[i - 1][j] >= dp[i][j - 1]) {
        i -= 1;
      } else {
        j -= 1;
      }
    }

    pairs.reverse();
    return pairs;
  }

  function suggestConflictText(currentText, backupText) {
    return [
      '<<<<<<< CURRENT',
      String(currentText ?? ''),
      '=======',
      String(backupText ?? ''),
      '>>>>>>> BACKUP',
    ].join('\n');
  }

  function buildExcerpt(lines, rangeStart, rangeEnd, contextLines) {
    const start = Math.max(0, rangeStart - contextLines);
    const end = Math.min(lines.length, rangeEnd + contextLines);
    const excerptLines = lines.slice(start, end);
    return {
      startIndex: start,
      endIndex: end,
      startLine: start + 1,
      endLine: end,
      excerptText: excerptLines.join('\n'),
      excerptLines,
    };
  }

  function buildConflictPayload(aLines, bLines, aStart, aEnd, bStart, bEnd, contextLines) {
    const context = Number.isFinite(contextLines) ? contextLines : 3;
    const currentExcerpt = buildExcerpt(aLines, aStart, aEnd, context);
    const backupExcerpt = buildExcerpt(bLines, bStart, bEnd, context);

    const currentHunkLines = aLines.slice(aStart, aEnd);
    const backupHunkLines = bLines.slice(bStart, bEnd);

    const suggestedText = [
      ...aLines.slice(0, aStart),
      '<<<<<<< CURRENT',
      ...currentHunkLines,
      '=======',
      ...backupHunkLines,
      '>>>>>>> BACKUP',
      ...aLines.slice(aEnd),
    ].join('\n');

    return {
      currentExcerpt: currentExcerpt.excerptText,
      backupExcerpt: backupExcerpt.excerptText,
      currentRange: { startLine: currentExcerpt.startLine, endLine: currentExcerpt.endLine },
      backupRange: { startLine: backupExcerpt.startLine, endLine: backupExcerpt.endLine },
      currentHunkRange: { startLine: aStart + 1, endLine: aEnd },
      backupHunkRange: { startLine: bStart + 1, endLine: bEnd },
      currentHunk: currentHunkLines.join('\n'),
      backupHunk: backupHunkLines.join('\n'),
      suggestedText,
    };
  }

  function diffLinesByLcs(aText, bText, options) {
    const settings = options && typeof options === 'object' ? options : {};
    const maxCells = Number.isFinite(settings.maxCells) ? settings.maxCells : 50_000;

    const aLines = splitLines(aText);
    const bLines = splitLines(bText);
    const pairs = computeLcsPairs(aLines, bLines, maxCells);
    if (!pairs) {
      return null;
    }

    const aMatched = new Array(aLines.length).fill(false);
    const bMatched = new Array(bLines.length).fill(false);
    for (const [ai, bi] of pairs) {
      aMatched[ai] = true;
      bMatched[bi] = true;
    }

    const aChanged = aMatched.map(matched => !matched);
    const bChanged = bMatched.map(matched => !matched);
    return { aChanged, bChanged };
  }

  function mergeTextByLcs(currentText, backupText, options) {
    const settings = options && typeof options === 'object' ? options : {};
    const maxCells = Number.isFinite(settings.maxCells) ? settings.maxCells : 200_000;
    const contextLines = Number.isFinite(settings.contextLines) ? settings.contextLines : 3;

    const aLines = splitLines(currentText);
    const bLines = splitLines(backupText);

    const pairs = computeLcsPairs(aLines, bLines, maxCells);
    if (!pairs) {
      const fallbackExcerpt = buildConflictPayload(
        aLines,
        bLines,
        0,
        Math.min(aLines.length, 40),
        0,
        Math.min(bLines.length, 40),
        0,
      );
      return {
        ok: false,
        reason: 'too_large',
        conflict: {
          currentText: String(currentText ?? ''),
          backupText: String(backupText ?? ''),
          ...fallbackExcerpt,
          suggestedText: suggestConflictText(currentText, backupText),
        },
      };
    }

    const merged = [];
    let aIndex = 0;
    let bIndex = 0;

    for (const [ai, bi] of pairs) {
      const aGap = aLines.slice(aIndex, ai);
      const bGap = bLines.slice(bIndex, bi);

      if (!linesEqual(aGap, bGap)) {
        if (aGap.length === 0) {
          merged.push(...bGap);
        } else if (bGap.length === 0) {
          merged.push(...aGap);
        } else if (isSubsequence(aGap, bGap)) {
          merged.push(...bGap);
        } else if (isSubsequence(bGap, aGap)) {
          merged.push(...aGap);
        } else {
          const excerpt = buildConflictPayload(aLines, bLines, aIndex, ai, bIndex, bi, contextLines);
          return {
            ok: false,
            reason: 'conflict',
            conflict: {
              currentText: String(currentText ?? ''),
              backupText: String(backupText ?? ''),
              ...excerpt,
              suggestedText: excerpt.suggestedText,
            },
          };
        }
      } else {
        merged.push(...aGap);
      }

      merged.push(aLines[ai]);
      aIndex = ai + 1;
      bIndex = bi + 1;
    }

    const aTail = aLines.slice(aIndex);
    const bTail = bLines.slice(bIndex);
    if (!linesEqual(aTail, bTail)) {
      if (aTail.length === 0) {
        merged.push(...bTail);
      } else if (bTail.length === 0) {
        merged.push(...aTail);
      } else if (isSubsequence(aTail, bTail)) {
        merged.push(...bTail);
      } else if (isSubsequence(bTail, aTail)) {
        merged.push(...aTail);
      } else {
        const excerpt = buildConflictPayload(
          aLines,
          bLines,
          aIndex,
          aLines.length,
          bIndex,
          bLines.length,
          contextLines,
        );
        return {
          ok: false,
          reason: 'conflict',
          conflict: {
            currentText: String(currentText ?? ''),
            backupText: String(backupText ?? ''),
            ...excerpt,
            suggestedText: excerpt.suggestedText,
          },
        };
      }
    } else {
      merged.push(...aTail);
    }

    return { ok: true, mergedText: merged.join('\n') };
  }

  window.padMerge = Object.freeze({
    fnv1a32,
    diffLinesByLcs,
    mergeTextByLcs,
  });
})();
