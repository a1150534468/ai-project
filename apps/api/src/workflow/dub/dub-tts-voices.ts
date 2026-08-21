export interface PresetVoice { readonly id: string; readonly label: string; readonly lang: "zh" | "en"; readonly gender: "male" | "female" }

// 来自 MiMo 预置精品音色列表（mimo-v2.5-tts）
export const DUB_PRESET_VOICES: readonly PresetVoice[] = [
  { id: "冰糖", label: "冰糖", lang: "zh", gender: "female" },
  { id: "茉莉", label: "茉莉", lang: "zh", gender: "female" },
  { id: "苏打", label: "苏打", lang: "zh", gender: "male" },
  { id: "白桦", label: "白桦", lang: "zh", gender: "male" },
  { id: "Mia", label: "Mia", lang: "en", gender: "female" },
  { id: "Chloe", label: "Chloe", lang: "en", gender: "female" },
  { id: "Milo", label: "Milo", lang: "en", gender: "male" },
  { id: "Dean", label: "Dean", lang: "en", gender: "male" },
];

export function isPresetVoice(id: string): boolean {
  return DUB_PRESET_VOICES.some((v) => v.id === id);
}
