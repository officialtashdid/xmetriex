import { parseBengaliDigits } from "./utils";
import { QuestionItem, QuestionSolution } from "@/types/exam";

export interface ParsedQuestionBlock {
  q: string;
  opts: string[];
  correct: number;
  exp: string;
  topic?: string;
  subtopic?: string;
  isValid: boolean;
  error?: string;
}

/**
 * Smart Question Parser
 * Supports Bengali & English numbered questions, options (ক/খ/গ/ঘ or a/b/c/d or 1/2/3/4),
 * answers (উত্তরঃ/উত্তর:/Ans:/Answer:) and explanations (ব্যাখ্যা:/Exp:/Explanation:),
 * and automatic hierarchy/topic/subtopic detection from markdown headers or 'টপিক:' tags.
 */
export function parseBulkQuestionsText(
  rawText: string,
  defaultTopic?: string,
  defaultSubtopic?: string
): {
  questions: QuestionItem[];
  solutions: QuestionSolution[];
  blocks: ParsedQuestionBlock[];
  validCount: number;
  totalParsed: number;
} {
  if (!rawText || !rawText.trim()) {
    return { questions: [], solutions: [], blocks: [], validCount: 0, totalParsed: 0 };
  }

  // Split into blocks by double newline or numbered questions or topic headers
  const lines = rawText.split(/\r?\n/);
  const rawBlocks: { lines: string[]; currentSectionTopic?: string; currentSectionSubtopic?: string }[] = [];
  let currentBlockLines: string[] = [];
  let activeTopic = defaultTopic?.trim() || "";
  let activeSubtopic = defaultSubtopic?.trim() || "";

  const isTopicHeader = (line: string) => {
    const trimmed = line.trim();
    return /^#+\s+|^\[?(টপিক|অধ্যায়|চ্যাপ্টার|অধ্যায়|বিষয়|বিষয়|Topic|Chapter|Subject)\]?\s*[:ঃ\-=]/i.test(trimmed);
  };

  const parseTopicHeader = (line: string) => {
    const trimmed = line.trim().replace(/^#+\s*/, "").replace(/^\[?(টপিক|অধ্যায়|চ্যাপ্টার|অধ্যায়|বিষয়|বিষয়|Topic|Chapter|Subject)\]?\s*[:ঃ\-=]\s*/i, "").trim();
    // Support hierarchy like "বাংলা সাহিত্য > প্রাচীন যুগ > চর্যাপদ" or "পরিবেশ / চুক্তি"
    const parts = trimmed.split(/\s*[>›/|]\s*/);
    if (parts.length >= 2) {
      return {
        topic: parts[0].trim(),
        subtopic: parts.slice(1).join(" > ").trim()
      };
    }
    return {
      topic: trimmed,
      subtopic: ""
    };
  };

  const isQuestionStart = (line: string) => {
    const trimmed = line.trim();
    // e.g. "১.", "1.", "প্রশ্ন ১:", "Q1.", "১)", "1)"
    return /^([০-৯\d]+[\.\)]|প্রশ্ন\s*[০-৯\d]*\s*[:\.]|Q\s*[০-৯\d]*\s*[:\.])/i.test(trimmed);
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    if (!trimmed) continue;

    // Check if line is a topic/chapter header
    if (isTopicHeader(trimmed)) {
      if (currentBlockLines.length > 0) {
        rawBlocks.push({ lines: currentBlockLines, currentSectionTopic: activeTopic, currentSectionSubtopic: activeSubtopic });
        currentBlockLines = [];
      }
      const parsedH = parseTopicHeader(trimmed);
      activeTopic = parsedH.topic || activeTopic;
      activeSubtopic = parsedH.subtopic || activeSubtopic;
      continue;
    }

    if (isQuestionStart(trimmed) && currentBlockLines.length > 0) {
      rawBlocks.push({ lines: currentBlockLines, currentSectionTopic: activeTopic, currentSectionSubtopic: activeSubtopic });
      currentBlockLines = [line];
    } else {
      currentBlockLines.push(line);
    }
  }

  if (currentBlockLines.length > 0) {
    rawBlocks.push({ lines: currentBlockLines, currentSectionTopic: activeTopic, currentSectionSubtopic: activeSubtopic });
  }

  const blocks: ParsedQuestionBlock[] = [];
  const questions: QuestionItem[] = [];
  const solutions: QuestionSolution[] = [];

  for (const blockData of rawBlocks) {
    const blockLines = blockData.lines;
    let qText = "";
    const opts: string[] = [];
    let correctIdx = 0;
    let exp = "";
    let ansFound = false;
    let inlineTopic = blockData.currentSectionTopic || "";
    let inlineSubtopic = blockData.currentSectionSubtopic || "";

    for (let j = 0; j < blockLines.length; j++) {
      const line = blockLines[j].trim();
      if (!line) continue;

      // Check Answer line (e.g. উত্তর: খ, উত্তরঃ খ, Ans: B, Answer: (গ), উ: ঘ, সঠিক উত্তর: গ)
      const ansMatch = line.match(/^(সঠিক\s*উত্তর|উত্তরঃ|উত্তর|উ\s*[:ঃ\.\-]|correct\s*answer|answer|correct\s*ans|ans|ans\s*[:ঃ\.\-]|answer\s*[:ঃ\.\-])[\s\-–—:ঃ\.]*([^\n\r]+)/i);
      if (ansMatch) {
        ansFound = true;
        const ansRaw = ansMatch[2].trim();
        // Remove brackets or punctuation e.g. "(খ)" -> "খ", "[B]" -> "B", "খ." -> "খ"
        const cleanAns = ansRaw.replace(/^[\(\[\{\s]+|[\)\]\}\s\.\-]+$/g, "").trim().toLowerCase();
        const normVal = parseBengaliDigits(cleanAns);

        // A line that merely STARTS with "উত্তর" (e.g. "উত্তর দেওয়ার আগে…") is
        // not an answer line unless the value looks like an option label.
        const looksLikeOption =
          /^[কখগঘabcdABCD১-৪1-4]/.test(cleanAns) ||
          opts.some((o) => o.toLowerCase().trim() === cleanAns);

        if (!looksLikeOption) {
          // Not an answer line — fall through and treat it as question text
          ansFound = false;
          if (!qText) {
            qText = line.replace(/^([০-৯\d]+[\.\)]|প্রশ্ন\s*[০-৯\d]*\s*[:\.]|Q\s*[০-৯\d]*\s*[:\.])\s*/i, "").trim();
          } else if (opts.length === 0) {
            qText += " " + line;
          }
          continue;
        }

        if (cleanAns.startsWith("ক") || cleanAns.startsWith("a") || normVal === "1" || normVal === "0") correctIdx = 0;
        else if (cleanAns.startsWith("খ") || cleanAns.startsWith("b") || normVal === "2") correctIdx = 1;
        else if (cleanAns.startsWith("গ") || cleanAns.startsWith("c") || normVal === "3") correctIdx = 2;
        else if (cleanAns.startsWith("ঘ") || cleanAns.startsWith("d") || normVal === "4") correctIdx = 3;
        else {
          // If the answer is the full option text, check against opts
          const matchedOptIdx = opts.findIndex((o) => o.toLowerCase().trim() === cleanAns);
          if (matchedOptIdx !== -1) {
            correctIdx = matchedOptIdx;
          }
        }
        continue;
      }

      // Check Explanation line
      const expMatch = line.match(/^(ব্যাখ্যা|ব্যাখ্যা\s*:|exp|explanation|ব্যাখ্যা\s*ঃ|note|নোট)[\s\-–—:]*([^\n\r]+)/i);
      if (expMatch) {
        exp = expMatch[2].trim();
        // capture subsequent lines as explanation if any
        for (let k = j + 1; k < blockLines.length; k++) {
          const nextL = blockLines[k].trim();
          if (!isQuestionStart(nextL)) {
            exp += " " + nextL;
            j = k;
          }
        }
        continue;
      }

      // A numbered line at the START of a block is the QUESTION, not an option.
      // Without this guard, question numbers "১."–"৪." (and ASCII digits) also
      // match the option regex below, so the question text gets swallowed as an
      // option and the block fails with "প্রশ্ন পাওয়া যায়নি"/option-count
      // errors — while Bengali "৫."–"৯."/multi-digit numbers never matched the
      // option class, which is why only the first few questions broke.
      const qNumMatch = !qText && line.match(/^[০-৯\d]+[\.\)]\s*(.+)/);
      if (qNumMatch) {
        qText = qNumMatch[1].trim();
        continue;
      }

      // Check Option line (e.g. "ক) ...", "ক. ...", "(ক) ...", "A) ...", "a.", "1) ...")
      // Check inline multiple options like "ক) ঢাকা  খ) খুলনা  গ) রাজশাহী  ঘ) সিলেট"
      // Split lines that carry multiple options like "ক) ঢাকা খ) খুলনা …" —
      // option TEXT may itself start with ক/খ/গ/ঘ/digits, so we split on the
      // option MARKERS rather than excluding letters from the text.
      // দশমিক সংখ্যা (যেমন "৫.৬ কিমি", "৩.৭", "1.5") যেন অপশন marker ("৩.") না
      // ভেবে ভুল split না হয়: digit+ডট সেকশন তখনই marker হয় যখন ডটের পর আরেকটা
      // অঙ্ক থাকে না (অর্থাৎ সত্যিকারের দশমিক নয়)। অক্ষর marker (ক/খ/গ/ঘ, a-d) আগের মতোই।
      const inlineOptRegex = /(?:^|\s)((?:[কখগঘabcdABCD][\)\.\-–—])|(?:[১-৪1-4](?:[\)\-–—]|\.(?![০-৯0-9]))))\s*([\s\S]*?)(?=\s+(?:(?:[কখগঘabcdABCD][\)\.\-–—])|(?:[১-৪1-4](?:[\)\-–—]|\.(?![০-৯0-9]))))|$)/g;
      const inlineMatches = Array.from(line.matchAll(inlineOptRegex));

      if (inlineMatches.length >= 2) {
        for (const m of inlineMatches) {
          const optClean = m[2].trim();
          if (optClean) opts.push(optClean);
        }
        continue;
      }

      const singleOptMatch = line.match(/^(\([কখগঘabcdABCD১-৪\d]\)|[কখগঘabcdABCD১-৪\d][\)\.\-–—])\s*(.+)/);
      if (singleOptMatch) {
        opts.push(singleOptMatch[2].trim());
        continue;
      }

      // Otherwise, it's part of the question text
      if (!qText) {
        // Strip leading number if present (e.g. "১. ", "1) ", "Q1: ")
        qText = line.replace(/^([০-৯\d]+[\.\)]|প্রশ্ন\s*[০-৯\d]*\s*[:\.]|Q\s*[০-৯\d]*\s*[:\.])\s*/i, "").trim();
      } else if (opts.length === 0) {
        qText += " " + line;
      }
    }

    // Track how many REAL options were parsed before padding placeholders —
    // padded placeholders must never make a broken block look valid.
    const realOptCount = opts.length;

    // Pad or trim options to exactly 4 if needed
    while (opts.length < 4) {
      opts.push(`অপশন ${opts.length + 1}`);
    }

    const hasTooMany = realOptCount > 4;
    const isValid = qText.length > 0 && opts.length >= 4 && realOptCount >= 2 && !hasTooMany && ansFound;
    let error: string | undefined = undefined;
    if (hasTooMany) error = "৪টির বেশি অপশন পাওয়া গেছে";
    else if (realOptCount < 2) error = "অপশন কম পাওয়া গেছে (কমপক্ষে ২টি প্রয়োজন)";
    if (!qText) error = "প্রশ্ন পাওয়া যায়নি";
    else if (!ansFound) error = "সঠিক উত্তর উল্লেখ নেই (ডিফল্ট: ক)";

    const block: ParsedQuestionBlock = {
      q: qText,
      opts: opts.slice(0, 4),
      correct: correctIdx,
      exp: exp,
      topic: inlineTopic || defaultTopic || undefined,
      subtopic: inlineSubtopic || defaultSubtopic || undefined,
      isValid,
      error
    };

    blocks.push(block);

    if (isValid) {
      questions.push({
        q: block.q,
        opts: block.opts,
        topic: block.topic,
        subtopic: block.subtopic
      });
      solutions.push({
        correct: block.correct,
        exp: block.exp
      });
    }
  }

  return {
    questions,
    solutions,
    blocks,
    validCount: questions.length,
    totalParsed: blocks.length
  };
}
