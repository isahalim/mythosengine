export default {
  async fetch(): Promise<Response> {
    return new Response("ok", { status: 200 });
  },
};
