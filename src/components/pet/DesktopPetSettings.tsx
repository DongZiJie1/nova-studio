import { useUiStore } from "../../stores/ui-store";

export function DesktopPetSettings() {
  const visible = useUiStore((state) => state.desktopPetVisible);
  const setVisible = useUiStore((state) => state.setDesktopPetVisible);

  return (
    <div className="settings-card">
      <div className="settings-card-copy">
        <h2>桌面宠物</h2>
        <p>露露会悬浮在桌面上，提醒你正在运行或需要关注的 Nova 会话。</p>
      </div>
      <button
        type="button"
        className="background-picker-button"
        aria-label="显示桌面宠物"
        aria-pressed={visible}
        onClick={() => setVisible(!visible)}
      >
        {visible ? "隐藏露露" : "显示露露"}
      </button>
    </div>
  );
}
