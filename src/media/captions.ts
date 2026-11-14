import { StudioError } from "../domain/errors.js";
import { speechResultSchema } from "./contracts.js";
import type { CaptionCue, SpeechResult } from "./contracts.js";

export function alignSpeech(input: SpeechResult, durationMs: number): { cues: CaptionCue[]; transcript: string } {
  const speech = speechResultSchema.parse(input);
  if (!Number.isFinite(durationMs) || durationMs <= 0) throw new StudioError("AUDIO_DURATION", "Measure the final audio before aligning captions.");
  let previousTime = -1;
  let previousCharacter = -1;
  for (const word of speech.boundaries) {
    if (word.startMs < previousTime || word.characterPosition < previousCharacter
      || word.startMs >= durationMs || word.characterPosition + word.characterCount > speech.text.length
      || speech.text.slice(word.characterPosition, word.characterPosition + word.characterCount) !== word.text) {
      throw new StudioError("SPEECH_BOUNDARIES", "Speech boundaries do not match the actual synthesized text/audio. Do not estimate replacement timings.");
    }
    previousTime = word.startMs; previousCharacter = word.characterPosition;
  }
  const cues: CaptionCue[] = [];
  let groupStart = 0;
  while (groupStart < speech.boundaries.length) {
    let end = groupStart + 1;
    while (end < speech.boundaries.length && end - groupStart < 8
      && speech.boundaries.slice(groupStart, end + 1).map((word) => word.text).join(" ").length <= 68) end++;
    const words = speech.boundaries.slice(groupStart, end);
    const startMs = words[0]!.startMs;
    const endMs = end < speech.boundaries.length ? speech.boundaries[end]!.startMs : durationMs;
    if (endMs <= startMs) throw new StudioError("CAPTION_BOUNDS", "Measured caption boundaries overlap or have no duration.");
    cues.push({ startMs, endMs, text: words.map((word) => word.text).join(" ") });
    groupStart = end;
  }
  validateCues(cues, durationMs);
  return { cues, transcript: speech.boundaries.map((word) => word.text).join(" ") };
}

export function validateCues(cues: CaptionCue[], durationMs: number): void {
  if (!cues.length) throw new StudioError("CAPTIONS_MISSING", "Final audio requires actual caption cues.");
  let previous = 0;
  for (const cue of cues) {
    if (!Number.isFinite(cue.startMs) || !Number.isFinite(cue.endMs) || cue.startMs < previous
      || cue.endMs <= cue.startMs || cue.endMs > durationMs + 1 || !cue.text.trim()) {
      throw new StudioError("CAPTION_BOUNDS", "Caption times must be ordered, non-overlapping and within final audio.");
    }
    previous = cue.endMs;
  }
}
function timestamp(ms: number, decimal: "." | ","): string {
  const total = Math.floor(ms);
  const pad = (value: number, length = 2) => String(value).padStart(length, "0");
  return `${pad(Math.floor(total / 3600000))}:${pad(Math.floor(total / 60000) % 60)}:${pad(Math.floor(total / 1000) % 60)}${decimal}${pad(total % 1000, 3)}`;
}
export function toSrt(cues: CaptionCue[]): string {
  return cues.map((cue, index) => `${index + 1}\n${timestamp(cue.startMs, ",")} --> ${timestamp(cue.endMs, ",")}\n${cue.text}\n`).join("\n");
}
export function toVtt(cues: CaptionCue[]): string {
  const safe = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return `WEBVTT\n\n${cues.map((cue) => `${timestamp(cue.startMs, ".")} --> ${timestamp(cue.endMs, ".")}\n${safe(cue.text)}\n`).join("\n")}`;
}
export function toAss(cues: CaptionCue[]): string {
  const time = (ms: number) => timestamp(ms, ".").replace(/^0/, "").slice(0, -1);
  const safe = (text: string) => text.replace(/[{}]/g, "").replace(/\\/g, "/").replace(/\r?\n/g, "\\N");
  return `[Script Info]\nScriptType: v4.00+\nPlayResX: 1280\nPlayResY: 720\n\n[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\nStyle: Default,Arial,30,&H00FFFFFF,&H00FFFFFF,&H00101827,&H80101827,-1,0,0,0,100,100,0,0,1,2,0,2,80,80,24,1\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n${cues.map((cue) => `Dialogue: 0,${time(cue.startMs)},${time(cue.endMs)},Default,,0,0,0,,${safe(cue.text)}`).join("\n")}\n`;
}
