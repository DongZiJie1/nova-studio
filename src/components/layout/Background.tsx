import { useUiStore } from "../../stores/ui-store";

const presets = {
  "mesh-indigo": {
    gradient: "from-indigo-50 via-white to-violet-50",
    orbs: [
      { color: "rgba(139,92,246,0.15)", x: "right-0 top-0", size: "h-[600px] w-[600px]" },
      { color: "rgba(99,102,241,0.12)", x: "left-0 bottom-0", size: "h-[500px] w-[500px]" },
    ],
  },
  "mesh-rose": {
    gradient: "from-rose-50 via-white to-orange-50",
    orbs: [
      { color: "rgba(244,63,94,0.12)", x: "right-0 top-0", size: "h-[600px] w-[600px]" },
      { color: "rgba(249,115,22,0.10)", x: "left-0 bottom-0", size: "h-[500px] w-[500px]" },
    ],
  },
  "mesh-emerald": {
    gradient: "from-emerald-50 via-white to-teal-50",
    orbs: [
      { color: "rgba(16,185,129,0.12)", x: "right-0 top-0", size: "h-[600px] w-[600px]" },
      { color: "rgba(20,184,166,0.10)", x: "left-0 bottom-0", size: "h-[500px] w-[500px]" },
    ],
  },
  "mesh-slate": {
    gradient: "from-slate-50 via-white to-gray-50",
    orbs: [
      { color: "rgba(100,116,139,0.08)", x: "right-0 top-0", size: "h-[600px] w-[600px]" },
      { color: "rgba(148,163,184,0.06)", x: "left-0 bottom-0", size: "h-[500px] w-[500px]" },
    ],
  },
  plain: {
    gradient: "from-white to-gray-50",
    orbs: [],
  },
};

type PresetKey = keyof typeof presets;

export function Background() {
  const bgPreset = useUiStore((s) => s.bgPreset);
  const customBgUrl = useUiStore((s) => s.customBgUrl);

  const preset = presets[bgPreset as PresetKey] ?? presets["mesh-indigo"];

  return (
    <div className="absolute inset-0 overflow-hidden">
      {/* Base gradient */}
      <div className={`absolute inset-0 bg-gradient-to-br ${preset.gradient}`} />

      {/* Blurred orbs */}
      {preset.orbs.map((orb, i) => (
        <div
          key={i}
          className={`absolute ${orb.x} ${orb.size} rounded-full opacity-30`}
          style={{
            background: `radial-gradient(circle, ${orb.color} 0%, transparent 70%)`,
            filter: "blur(80px)",
          }}
        />
      ))}

      {/* Custom background image */}
      {customBgUrl && (
        <div
          className="absolute inset-0 opacity-[0.07]"
          style={{
            backgroundImage: `url(${customBgUrl})`,
            backgroundSize: "cover",
            backgroundPosition: "center",
          }}
        />
      )}
    </div>
  );
}
