// Shared by the browser and API so duration previews and submitted jobs agree.
export const DURATION_OPTIONS = Object.freeze([2, 4, 6, 8, 12, 20, 30, 60]);

const numberPattern = '(?:\\d+(?:\\.\\d+)?|[零〇一二两三四五六七八九十百千]+|半)';
const unitPattern = '(?:秒钟?|seconds?(?![a-z])|secs?(?![a-z])|s(?![a-z])|分钟?|minutes?(?![a-z])|mins?(?![a-z]))';
const joinPattern = '(?:或者|或|和|与|、|/|至|到|[-~～])';
const quantityPattern = `${numberPattern}\\s*[-－]?\\s*(?:${unitPattern})`;
// Lists are deliberately collected as candidates, never silently reduced to
// their first number: "8秒或12秒" needs an explicit choice.
const expressionPattern = `(?:${numberPattern}\\s*(?:[-－]?\\s*${unitPattern})?\\s*${joinPattern}\\s*)*${quantityPattern}`;
const connectPattern = '\\s*(?:(?:设置为|设为|控制在|大约|约为|为|是|共|约|[:：=])\\s*)*';
const digits = { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };

function numberValue(value) {
  if (/^\d+(?:\.\d+)?$/.test(value)) return Number(value);
  if (value === '半') return 0.5;
  if (!/[十百千]/.test(value)) return Number([...value].map(character => digits[character]).join(''));
  let total = 0;
  let pending;
  let previousUnit = Infinity;
  for (const character of value) {
    if (Object.hasOwn(digits, character)) {
      if (pending !== undefined && pending !== 0) return NaN;
      pending = digits[character];
    } else {
      const unit = { 十: 10, 百: 100, 千: 1000 }[character];
      if (!unit || unit >= previousUnit) return NaN;
      total += (pending ?? 1) * unit;
      pending = undefined;
      previousUnit = unit;
    }
  }
  return total + (pending ?? 0);
}

function validate(seconds, provider) {
  if (typeof seconds !== 'number' || !Number.isInteger(seconds) || seconds < 2 || seconds > 60) {
    throw new Error('视频时长须为 2–60 秒的整数。');
  }
  if (provider === 'sora' && ![4, 8, 12].includes(seconds)) {
    throw new Error('Sora 2 当前仅支持 4、8 或 12 秒，请调整时长或选择本地 Wan。');
  }
  return seconds;
}

function isAuxiliary(text, start) {
  // A source template or individual shot does not specify the finished length.
  const clause = text.slice(0, start).split(/[，。；,;\n]/).at(-1).trim();
  return /(?:每(?:个|一)?(?:镜头|片段|段|帧)|单(?:个|一)?(?:镜头|片段|段)|镜头|片段|动作|原(?:始)?(?:视频|模板|片)?|参考(?:视频|模板)?|模板)\s*$/.test(clause);
}

function expressionValues(expression) {
  const tokens = [...expression.matchAll(new RegExp(`(${numberPattern})\\s*[-－]?\\s*(${unitPattern})?`, 'giu'))];
  return tokens.map((token, index) => {
    const unit = token[2] || tokens.slice(index + 1).find(item => item[2])?.[2] || tokens.findLast(item => item[2])?.[2];
    const multiplier = /^(?:分|min)/i.test(unit) ? 60 : 1;
    return numberValue(token[1]) * multiplier;
  });
}

function fromPrompt(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > 10_000) {
    throw new Error('请在提示词中写明视频时长，例如“总时长 8 秒”。');
  }
  const text = value.normalize('NFKC');
  const label = '(?:总视频时长|最终视频时长|目标视频时长|视频总时长|总时长|总长度|成片时长|最终时长|目标时长|视频时长|片长|时长|持续时间|duration|video\\s+length)';
  const labeled = [...text.matchAll(new RegExp(`${label}${connectPattern}(?<duration>${expressionPattern})`, 'giu'))]
    .filter(match => !isAuxiliary(text, match.index));
  let matches = labeled;
  if (!matches.length) {
    matches = [...text.matchAll(new RegExp(`(?<![\\d零〇一二两三四五六七八九十百千.+-])(?<duration>${expressionPattern})\\s*(?:的|[-－])?\\s*(?:视频|短片|影片|片子|videos?(?![a-z])|clips?(?![a-z]))`, 'giu'))]
      .filter(match => !isAuxiliary(text, match.index));
  }
  if (!matches.length) throw new Error('未识别到目标视频时长。请写明“总时长 8 秒”，或手动选择时长。');
  const values = matches.flatMap(match => {
    // Do not misread "1分钟30秒" as just one minute. Users can write a single
    // unit (e.g. "0.5分钟") or select the total seconds explicitly.
    const remainder = text.slice(match.index + match[0].length);
    if (new RegExp(`^\\s*${quantityPattern}`, 'iu').test(remainder)) {
      throw new Error('请将目标时长写成单一单位，例如“总时长 30 秒”，避免多段时长歧义。');
    }
    return expressionValues(match.groups.duration);
  });
  const unique = [...new Set(values)];
  if (unique.length !== 1) throw new Error('提示词包含多个不同的目标时长，请只保留一个总时长，或手动选择。');
  return unique[0];
}

export function resolveDuration({ provider, prompt, seconds, durationMode = 'manual' } = {}) {
  if (!['comfyui', 'demo', 'sora'].includes(provider)) throw new Error('请选择有效的生成模式。');
  if (!['manual', 'prompt'].includes(durationMode)) throw new Error('请选择手动时长或根据提示词识别时长。');
  return validate(durationMode === 'prompt' ? fromPrompt(prompt) : seconds, provider);
}
