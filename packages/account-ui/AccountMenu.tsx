"use client";
import { useEffect, useState } from "react";
import { useLoggedFailure } from "../ui/client-feedback";
type Account = {
  role: "patient" | "clinician";
  displayName: string;
  patientId: string | null;
  patients: string[];
};
export function AccountMenu({ onLeave }: { onLeave?: () => void }) {
  const [account, setAccount] = useState<Account | null>(null),
    [error, setError] = useState("");
  useLoggedFailure("Panda account", error);
  useEffect(() => {
    let active = true;
    void fetch("/auth/config")
      .then((r) => r.json())
      .then(async (config) => {
        if (!config.enabled) return;
        const response = await fetch("/auth/session");
        if (response.status === 401) {
          window.location.assign("/auth");
          return;
        }
        const out = await response.json();
        if (out.ok && active) setAccount(out.data);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, []);
  async function action(path: string, method: string, body?: unknown) {
    onLeave?.();
    setError("");
    try {
      const response = await fetch(path, {
        method,
        headers: { "Content-Type": "application/json" },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      const out = await response.json();
      if (!out.ok) throw Error(out.error.message);
      window.location.assign(path === "/auth/session" ? "/auth" : "/care");
    } catch (e) {
      setError((e as Error).message);
    }
  }
  if (!account) return null;
  return (
    <details
      style={{
        display: "inline-block",
        position: "relative",
        fontSize: 13,
        marginLeft: 12,
      }}
    >
      <summary style={{ cursor: "pointer" }}>Account</summary>
      <div
        style={{
          position: "absolute",
          right: 0,
          top: "100%",
          zIndex: 30,
          width: 240,
          padding: 16,
          background: "white",
          border: "1px solid #dce5db",
          borderRadius: 12,
          boxShadow: "0 8px 28px #18372f22",
        }}
      >
        <strong>{account.displayName || "Your account"}</strong>
        <p>{account.role === "clinician" ? "Care team" : "Patient"}</p>
        {account.role === "clinician" && (
          <label>
            Patient
            <select
              value={account.patientId || ""}
              onChange={(e) =>
                void action("/auth/select-patient", "POST", {
                  patientId: e.target.value,
                })
              }
            >
              <option value="" disabled>
                Select a patient
              </option>
              {account.patients.map((id) => (
                <option key={id} value={id}>
                  Patient {id.slice(-8)}
                </option>
              ))}
            </select>
          </label>
        )}
        <button
          type="button"
          className="secondary"
          onClick={() => void action("/auth/session", "DELETE")}
        >
          Sign out
        </button>

      </div>
    </details>
  );
}
