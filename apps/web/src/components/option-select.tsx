import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

export interface Option {
  value: string;
  label: string;
}

/**
 * Single-choice dropdown over a flat option list: the shadcn Select, wired the way the native `<select>` was used.
 *
 * Base UI's `Select.Value` renders the raw `value` string unless it can resolve a label: `items` on the root
 * only helps while the value is present in it. Resolving the label here means the trigger can never leak a
 * raw id (e.g. a key id before the key list has loaded); it shows the placeholder instead.
 */
export function OptionSelect({
  value,
  onValueChange,
  options,
  placeholder,
  className,
  disabled,
  "aria-label": ariaLabel,
}: {
  value: string;
  onValueChange: (value: string) => void;
  options: readonly Option[];
  placeholder?: string;
  className?: string;
  disabled?: boolean;
  "aria-label"?: string;
}) {
  return (
    <Select
      value={value}
      items={options}
      disabled={disabled}
      onValueChange={(next) => next !== null && onValueChange(next)}
    >
      <SelectTrigger className={className ?? "w-full"} aria-label={ariaLabel}>
        <SelectValue placeholder={placeholder}>
          {(current: string | null) =>
            options.find((option) => option.value === current)?.label ?? placeholder
          }
        </SelectValue>
      </SelectTrigger>
      <SelectContent>
        <SelectGroup>
          {options.map((option) => (
            <SelectItem key={option.value} value={option.value}>
              {option.label}
            </SelectItem>
          ))}
        </SelectGroup>
      </SelectContent>
    </Select>
  );
}
