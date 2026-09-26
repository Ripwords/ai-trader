export interface ConfirmOptions {
  title: string
  description?: string
  confirmLabel: string
}

export type OpenConfirm = (props: ConfirmOptions) => { result: Promise<unknown> }

/** Esc and the modal's close button resolve with undefined, which counts as no. */
export async function askConfirm(open: OpenConfirm, opts: ConfirmOptions): Promise<boolean> {
  return (await open(opts).result) === true
}
