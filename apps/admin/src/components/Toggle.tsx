interface Props {
  checked: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
  label?: string;
}

export default function Toggle({ checked, onChange, disabled, label }: Props) {
  return (
    <label className={`toggle ${disabled ? "toggle-disabled" : ""}`.trim()} onClick={(e) => e.stopPropagation()}>
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span className="toggle-track">
        <span className="toggle-thumb" />
      </span>
      {label && <span className="toggle-label">{label}</span>}
    </label>
  );
}
