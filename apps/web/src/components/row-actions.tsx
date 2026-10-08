import { MoreHorizontalIcon, type LucideIcon } from "lucide-react";
import { Fragment } from "react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

interface ActionBase {
  label: string;
  icon?: LucideIcon;
  disabled?: boolean;
}

/** A menu entry that runs `onSelect`. */
export interface RowAction extends ActionBase {
  onSelect: () => void;
  /** Red styling for irreversible actions; put them in their own group. */
  destructive?: boolean;
}

/** A menu entry that opens a submenu of plain choices (e.g. "Remove limit" → one item per limit). */
export interface RowSubmenu extends ActionBase {
  items: { label: string; onSelect: () => void }[];
}

export type RowEntry = RowAction | RowSubmenu;

const isSubmenu = (entry: RowEntry): entry is RowSubmenu => "items" in entry;

function Entry({ entry }: { entry: RowEntry }) {
  const Icon = entry.icon;
  if (isSubmenu(entry)) {
    return (
      <DropdownMenuSub>
        <DropdownMenuSubTrigger disabled={entry.disabled}>
          {Icon && <Icon />}
          {entry.label}
        </DropdownMenuSubTrigger>
        <DropdownMenuSubContent>
          {entry.items.map((item) => (
            <DropdownMenuItem key={item.label} disabled={entry.disabled} onClick={item.onSelect}>
              {item.label}
            </DropdownMenuItem>
          ))}
        </DropdownMenuSubContent>
      </DropdownMenuSub>
    );
  }
  return (
    <DropdownMenuItem
      variant={entry.destructive ? "destructive" : "default"}
      disabled={entry.disabled}
      onClick={entry.onSelect}
    >
      {Icon && <Icon />}
      {entry.label}
    </DropdownMenuItem>
  );
}

/**
 * The last cell of every table record: one "more" button that opens the record's actions.
 * Entries are split into groups divided by a separator; falsy entries and empty groups are
 * dropped, and nothing renders when no entry is left.
 */
export function RowActions({
  label,
  groups,
}: {
  /** Names the record for assistive tech, e.g. `Actions for openai`. */
  label: string;
  groups: (RowEntry | false | null | undefined)[][];
}) {
  const shown = groups
    .map((g) => g.filter((entry): entry is RowEntry => !!entry))
    .filter((g) => g.length > 0);
  if (shown.length === 0) return null;

  return (
    <div className="flex justify-end">
      <DropdownMenu>
        <DropdownMenuTrigger render={<Button variant="ghost" size="icon-sm" aria-label={label} />}>
          <MoreHorizontalIcon />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="min-w-44">
          {shown.map((group, i) => (
            <Fragment key={i}>
              {i > 0 && <DropdownMenuSeparator />}
              <DropdownMenuGroup>
                {i === 0 && <DropdownMenuLabel>Actions</DropdownMenuLabel>}
                {group.map((entry) => (
                  <Entry key={entry.label} entry={entry} />
                ))}
              </DropdownMenuGroup>
            </Fragment>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
