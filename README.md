# workers-email-archiver

[![license](https://img.shields.io/github/license/tweedge/workers-email-archiver)](https://github.com/tweedge/workers-email-archiver)
[![runs on cloudflare](https://img.shields.io/badge/runs%20on-cloudflare-orange.svg)](https://developers.cloudflare.com/email-routing/email-workers/)
[![written by](https://img.shields.io/badge/written%20by-some%20nerd-red.svg)](https://chris.partridge.tech)

This is a Workers script that I use to receive email via Cloudflare Workers, compress the raw email, and store that compressed data in an S3-compatible provider for long-term archiving and analysis. It uses:

* [fflate](https://github.com/101arrowz/fflate) to compress data using gzip
* [aws4fetch](https://github.com/mhart/aws4fetch) to save the compressed data to S3

This script and its dependencies are pure-JavaScript and weigh in at ~25KB total.

### Usage

This repo is what I personally use and isn't a template/general-use tool - please feel free to use/copy/adapt it (per LICENSE.txt) but updates may break things and you may need to tweak what's happening for your specific needs.

The only variables you'll *probably* need to tinker with to get started are:

* In `wrangler.toml`, replace `S3_BUCKET` with your bucket name and `S3_ENDPOINT` with the S3 server you're using (this is the full endpoint, the entire domain including the region - if applicable).
* After deploying for the first time, add secrets named `S3_ACCESS_KEY` and `S3_ACCESS_SECRET` with your S3 signing credentials. Or just add them to your `wrangler.toml` if you're sure you won't accidentally commit or expose them (hint: this is a risk, and probably not one worth taking).

Commonly-used commands:

```
# install dependencies
npm install

# deploy worker
npm run deploy  # you'll be prompted to log in if you aren't already

# logout if you're logged into the wrong Cloudflare account
npm run logout

# monitor your production deployment
npm run tail
```

### Why did you make this?

Let's say, hypothetically, you had 75k emails coming in per day which you needed to store somewhere for later processing. Maybe you're a business, and you require the upmost uptime and missing even one email would be a catastrophe. Or maybe you're some random security engineer buying expired domains to guard against account takeover attacks and track/report spam.

A business probably wouldn't balk at paying $0.10-$1.80 per 1k emails. They're overpaying for the emails, but paying for the hands-off solutions, someone you can page overnight if there's a problem with that service, support, etc.

But a rando would balk, and this rando set out to find a new email archiving solution after noticing my cloud bills skyrocketing due to a *choice* domain I picked up. What's a nerd to do? Build my own, of course.

The lowest cost provider I could find was Cloudflare, which doesn't have any surchage for email pricing, and the only expenses are Workers (TL;DR: what if the cloud ran JavaScript in the V8 engine). Workers has a generous free tier of 100,000 requests *per day* - so you can turn that bill of 75 * 0.1 = $7.5/day (*on the **low end***) into $0, as long as you don't mind losing email over that limit. Or pony up for a paid plan and spend $5/mo plus usage (magnitudes less money) if you're needing higher limits.
