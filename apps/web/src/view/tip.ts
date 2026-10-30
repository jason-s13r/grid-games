// "Support the game": the tip link as a QR code, to pay on your own phone,
// with a link to open it here instead. The link comes from the Worker
// (TIP_URL); with none, the button stays hidden. As on the other Qot. games.

import qrcode from "qrcode-generator";

export function offerTip(url: string): void {
  const button = document.querySelector<HTMLButtonElement>("[data-support]");
  const dialog = document.querySelector<HTMLDialogElement>("[data-tip]");
  if (!button || !dialog) return;
  button.hidden = !url;
  if (!url) return;

  button.onclick = () => {
    const qr = qrcode(0, "M");
    qr.addData(url);
    qr.make();
    dialog.querySelector<HTMLElement>("[data-tip-qr]")!.innerHTML = qr.createSvgTag({ cellSize: 6, margin: 0, scalable: true });
    dialog.querySelector<HTMLElement>("[data-tip-address]")!.textContent = url.replace(/^https:\/\//, "");
    dialog.querySelector<HTMLAnchorElement>("[data-tip-open]")!.href = url;
    dialog.showModal();
  };
  dialog.querySelector<HTMLButtonElement>("[data-tip-close]")!.onclick = () => dialog.close();
  // A click on the backdrop (the dialog itself, outside its box) closes it.
  dialog.onclick = (event) => {
    if (event.target === dialog) dialog.close();
  };
}
