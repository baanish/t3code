import { FolderIcon } from "lucide-react";
import { useState } from "react";
import { resolveServerUrl } from "~/lib/utils";

const serverHttpOrigin = resolveServerUrl({
  protocol: "http",
});

const loadedProjectFaviconSrcs = new Set<string>();

export function ProjectFavicon({ cwd, className }: { cwd: string; className?: string }) {
  const src = `${serverHttpOrigin}/api/project-favicon?cwd=${encodeURIComponent(cwd)}`;
  const [status, setStatus] = useState<"loading" | "loaded" | "error">(() =>
    loadedProjectFaviconSrcs.has(src) ? "loaded" : "loading",
  );

  return (
    <>
      {status !== "loaded" ? (
        <FolderIcon className={`size-3.5 shrink-0 text-muted-foreground/50 ${className ?? ""}`} />
      ) : null}
      <img
        src={src}
        alt=""
        className={`size-3.5 shrink-0 rounded-sm object-contain ${status === "loaded" ? "" : "hidden"} ${className ?? ""}`}
        onLoad={() => {
          loadedProjectFaviconSrcs.add(src);
          setStatus("loaded");
        }}
        onError={() => setStatus("error")}
      />
    </>
  );
}
