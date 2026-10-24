export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(
      fetch(env.SITE_URL.replace(/\/$/, '') + '/api/cron/hourly', {
        method: 'POST',
        headers: { 'x-cron-key': env.CRON_SECRET },
      }).then((response) => {
        if (!response.ok) throw new Error(`Hourly job returned ${response.status}`);
      }),
    );
  },
};
