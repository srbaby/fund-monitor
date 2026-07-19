import { handleRequest } from "../src/router.mjs";

export async function onRequest(context) {
  return handleRequest(context.request, context.env, context);
}
