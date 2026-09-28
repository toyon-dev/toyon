/** the text of a fenced block as the clipboard should take it: marked's default renderer closes
 * the code with a newline the fence never had, ours does not, and neither is part of the code */
export const blockText = (text: string) => text.replace(/\n$/, "");
