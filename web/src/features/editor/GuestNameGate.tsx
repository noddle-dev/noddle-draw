/**
 * features/editor/GuestNameGate — a guest opening a share link must enter a
 * display name before joining the live room (so teammates see a real name in
 * presence/cursors, not an anonymous "Guest-xxxx"). Signed-in users skip this.
 */
import { useState } from "react";
import { setGuestName } from "../../state/collabStore";
import { BrandLogo } from "../../shared/ui";

export function GuestNameGate({ onDone }: { onDone: () => void }) {
  const [name, setName] = useState("");
  const submit = () => {
    if (!name.trim()) return;
    setGuestName(name.trim());
    onDone();
  };
  return (
    <div className="gen-overlay">
      <div className="gen-modal" style={{ width: 380, textAlign: "left" }}>
        <span style={{ display: "inline-flex", width: 34, height: 34, margin: "0 0 14px" }}>
          <BrandLogo size={34} />
        </span>
        <div className="t" style={{ marginBottom: 4 }}>Join board</div>
        <p className="muted" style={{ fontSize: 13, margin: "0 0 14px", lineHeight: 1.5 }}>
          Enter a display name so others see you while co-editing — asked once, remembered on this device.
        </p>
        <input
          className="text-input"
          autoFocus
          placeholder="Your name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") submit(); }}
          style={{ width: "100%", marginBottom: 14 }}
        />
        <button className="btn btn-grad btn-block" disabled={!name.trim()} onClick={submit}>
          Join board →
        </button>
      </div>
    </div>
  );
}
