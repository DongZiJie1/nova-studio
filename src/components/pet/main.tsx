import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { isTauri } from "@tauri-apps/api/core";
import { emitTo, listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { ArrowUpRight, X } from "lucide-react";
import { PET_ACTION, PET_STATUS, PET_WINDOW, type PetAction, type PetStatus } from "./events";
import "./pet.css";

const labels: Record<PetStatus["kind"], string> = {
  idle: "Nova 待命",
  running: "正在运行",
  waiting: "等你确认或回复",
  completed: "任务已完成",
  error: "任务遇到问题",
  stopped: "已停止",
};

function sendAction(action: PetAction) {
  if (!isTauri()) return;
  void emitTo("main", PET_ACTION, action).catch((error) => console.error("Desktop pet action failed:", error));
}

function DesktopPet() {
  const [status, setStatus] = useState<PetStatus>({ kind: "idle" });

  useEffect(() => {
    if (!isTauri()) return;
    const subscription = listen<PetStatus>(PET_STATUS, ({ payload }) => setStatus(payload), { target: PET_WINDOW });
    void subscription.then(() => sendAction("ready")).catch((error) => console.error("Desktop pet status unavailable:", error));
    return () => { void subscription.then((unlisten) => unlisten()).catch(() => {}); };
  }, []);

  const description = status.running && status.running > 1 ? `${status.running} 个会话运行中` : status.session;

  return (
    <main className="pet" data-status={status.kind} aria-label="桌面宠物露露">
      <div className="pet-character" title="拖动露露" onPointerDown={(event) => {
        if (event.button !== 0 || !isTauri()) return;
        event.preventDefault();
        void getCurrentWindow().startDragging().catch((error) => console.error("Failed to drag desktop pet:", error));
      }}>
        <img className="pet-stand" src={`${import.meta.env.BASE_URL}images/desktop-pet-lulu.webp`} alt="露露" draggable={false} />
        <img className="pet-run" src={`${import.meta.env.BASE_URL}images/desktop-pet-lulu-run.webp`} alt="" draggable={false} />
        <img className="pet-nap" src={`${import.meta.env.BASE_URL}images/desktop-pet-lulu-nap.webp`} alt="" draggable={false} />
      </div>
      <div className="pet-card">
        <div role="status" className="pet-status">
          <strong>{labels[status.kind]}</strong>
          {description && <span title={description}>{description}</span>}
        </div>
        <button type="button" aria-label="打开 Nova Studio" title="打开 Nova Studio" onClick={() => sendAction("open")}><ArrowUpRight size={15} /></button>
        <button type="button" aria-label="隐藏露露" title="隐藏露露" onClick={() => sendAction("hide")}><X size={14} /></button>
      </div>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<DesktopPet />);
