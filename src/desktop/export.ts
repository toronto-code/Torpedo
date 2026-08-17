import { invoke, isTauri } from "@tauri-apps/api/core";

export async function exportText(
  fileName: string,
  contents: string,
): Promise<string> {
  if (isTauri()) {
    return invoke<string>("export_text", { fileName, contents });
  }
  const blob = new Blob([contents], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  anchor.click();
  URL.revokeObjectURL(url);
  return `Downloaded ${fileName}`;
}
