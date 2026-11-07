import { cn } from "@/lib/utils";

/** Fan-out mark (docs/brand): input ring and spokes follow the tile foreground, provider dots keep the brand signal colour. */
export function BrandMark({ className }: { className?: string }) {
  return (
    <span
      className={cn(
        "grid size-8 shrink-0 place-items-center rounded-lg bg-primary text-primary-foreground",
        className,
      )}
    >
      <svg viewBox="24 24 208 208" className="size-3/4" aria-hidden="true">
        <path
          fill="currentColor"
          fillRule="evenodd"
          d="M73.5 78a50 50 0 1 0 0 100a50 50 0 1 0 0 -100ZM73.5 102a26 26 0 1 1 0 52a26 26 0 1 1 0 -52Z"
        />
        <path
          fill="currentColor"
          d="M119.99 136.49L187.87 68.6L170.9 51.63L103.01 119.51Z M111.5 140L207.5 140L207.5 116L111.5 116Z M103.01 136.49L170.9 204.37L187.87 187.4L119.99 119.51Z"
        />
        <g fill="#F2542D">
          <circle cx="179.38" cy="60.12" r="25" />
          <circle cx="207.5" cy="128" r="25" />
          <circle cx="179.38" cy="195.88" r="25" />
        </g>
      </svg>
    </span>
  );
}
