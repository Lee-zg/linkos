import { useDesktopPreferences } from "./DesktopPreferencesProvider";
import type { DesktopPreferencesV1 } from "./desktop-preferences";

type DockPrefs = DesktopPreferencesV1["dock"];

function Slider({
  value,
  min,
  max,
  step,
  onChange,
  label,
}: {
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (v: number) => void;
  label: string;
}) {
  return (
    <div className="dock-settings-row">
      <label className="dock-settings-label">{label}</label>
      <div className="dock-settings-control">
        <input
          type="range"
          min={min}
          max={max}
          step={step}
          value={value}
          onChange={(e) => onChange(Number(e.target.value))}
          className="dock-settings-slider"
          aria-label={label}
        />
        <span className="dock-settings-value">{value}</span>
      </div>
    </div>
  );
}

function Toggle({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: () => void;
  label: string;
}) {
  return (
    <div className="dock-settings-row">
      <label className="dock-settings-label">{label}</label>
      <div className="dock-settings-control">
        <button
          className={`dock-settings-toggle ${checked ? "is-on" : ""}`}
          role="switch"
          aria-checked={checked}
          aria-label={label}
          onClick={onChange}
        >
          <span className="dock-settings-toggle-knob" />
        </button>
      </div>
    </div>
  );
}

function SegmentedControl<T extends string>({
  value,
  options,
  onChange,
  label,
}: {
  value: T;
  options: readonly { value: T; label: string }[];
  onChange: (v: T) => void;
  label: string;
}) {
  return (
    <div className="dock-settings-row">
      <label className="dock-settings-label">{label}</label>
      <div className="dock-settings-control">
        <div className="dock-settings-segmented" role="radiogroup" aria-label={label}>
          {options.map((opt) => (
            <button
              key={opt.value}
              role="radio"
              aria-checked={value === opt.value}
              className={`dock-settings-segment ${value === opt.value ? "is-active" : ""}`}
              onClick={() => onChange(opt.value)}
            >
              {opt.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

function updateDock(
  current: DesktopPreferencesV1,
  patch: Partial<DockPrefs>,
): DesktopPreferencesV1 {
  return {
    ...current,
    dock: { ...current.dock, ...patch },
  };
}

export function DesktopDockSettings() {
  const { preferences, setPreferences } = useDesktopPreferences();
  const dock = preferences.dock;

  return (
    <section className="dock-settings-panel">
      <h3 className="dock-settings-title">Dock</h3>

      <Slider
        label="图标尺寸"
        value={dock.size}
        min={24}
        max={80}
        step={2}
        onChange={(size) =>
          setPreferences((prev) => updateDock(prev, { size }))
        }
      />

      <Toggle
        label="放大"
        checked={dock.magnification}
        onChange={() =>
          setPreferences((prev) =>
            updateDock(prev, { magnification: !prev.dock.magnification }),
          )
        }
      />

      {dock.magnification && (
        <Slider
          label="放大倍率"
          value={dock.magnificationScale}
          min={1}
          max={2}
          step={0.1}
          onChange={(magnificationScale) =>
            setPreferences((prev) =>
              updateDock(prev, { magnificationScale }),
            )
          }
        />
      )}

      <SegmentedControl
        label="位置"
        value={dock.position}
        options={[
          { value: "bottom", label: "底部" },
          { value: "left", label: "左侧" },
          { value: "right", label: "右侧" },
        ]}
        onChange={(position) =>
          setPreferences((prev) => updateDock(prev, { position }))
        }
      />

      <SegmentedControl
        label="最小化动画"
        value={dock.minimizeEffect}
        options={[
          { value: "genie", label: "精灵" },
          { value: "scale", label: "缩放" },
        ]}
        onChange={(minimizeEffect) =>
          setPreferences((prev) => updateDock(prev, { minimizeEffect }))
        }
      />

      <Toggle
        label="最小化收入应用图标"
        checked={dock.minimizeIntoAppIcon}
        onChange={() =>
          setPreferences((prev) =>
            updateDock(prev, {
              minimizeIntoAppIcon: !prev.dock.minimizeIntoAppIcon,
            }),
          )
        }
      />

      <Toggle
        label="应用打开弹跳"
        checked={dock.animateOpening}
        onChange={() =>
          setPreferences((prev) =>
            updateDock(prev, {
              animateOpening: !prev.dock.animateOpening,
            }),
          )
        }
      />

      <Toggle
        label="自动隐藏"
        checked={dock.autoHide}
        onChange={() =>
          setPreferences((prev) =>
            updateDock(prev, { autoHide: !prev.dock.autoHide }),
          )
        }
      />

      <Toggle
        label="运行指示点"
        checked={dock.showRunningIndicators}
        onChange={() =>
          setPreferences((prev) =>
            updateDock(prev, {
              showRunningIndicators: !prev.dock.showRunningIndicators,
            }),
          )
        }
      />

      <Toggle
        label="最近应用"
        checked={dock.showRecentApps}
        onChange={() =>
          setPreferences((prev) =>
            updateDock(prev, {
              showRecentApps: !prev.dock.showRecentApps,
            }),
          )
        }
      />
    </section>
  );
}
