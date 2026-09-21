import { useEffect, useId, useRef, useState } from "react";
import { TextInput } from "@carbon/react";

export default function NumField({
  label,
  value,
  min,
  max,
  decimals = 0,
  hideLabel = false,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  decimals?: number;
  hideLabel?: boolean;
  onChange: (n: number) => void;
}) {
  const id = useId();
  const [text, setText] = useState(String(value));
  const last = useRef(value);

  useEffect(() => {
    if (value !== last.current) {
      last.current = value;
      setText(String(value));
    }
  }, [value]);

  return (
    <TextInput
      id={id}
      labelText={label}
      hideLabel={hideLabel}
      value={text}
      onChange={(e) => {
        const raw = e.target.value;
        setText(raw);
        if (raw.trim() === "") return;
        const n = Number(raw);
        if (!Number.isFinite(n)) return;
        const factor = 10 ** decimals;
        const rounded = Math.round(n * factor) / factor;
        const clamped = Math.min(max, Math.max(min, rounded));
        last.current = clamped;
        onChange(clamped);
      }}
      onBlur={() => setText(String(last.current))}
    />
  );
}
