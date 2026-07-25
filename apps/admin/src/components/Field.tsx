import type { ReactNode } from "react";

interface Props {
  label: ReactNode;
  hint?: ReactNode;
  required?: boolean;
  children: ReactNode;
}

export default function Field({ label, hint, required, children }: Props) {
  return (
    <label className="field">
      <span className="field-label">
        {label}
        {required && <b className="field-required"> *</b>}
      </span>
      {children}
      {hint && <span className="field-hint">{hint}</span>}
    </label>
  );
}
