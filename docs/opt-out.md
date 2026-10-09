# Employer opt-out

WalkPath lists internships by polling the public job-board endpoints of applicant-tracking systems
that employers publish for exactly this purpose. Every listing shows the employer's own description
with attribution and links only to the employer's own apply page. WalkPath never collects
applications and never contacts candidates.

If you represent an employer and would like your listings removed:

1. Open an issue at https://github.com/alterj07/walkpath/issues/new?template=add-company.yml with
   the title `registry: remove <company>` and your careers URL, or open a security advisory if you
   prefer a private channel.
2. A maintainer sets the board's status to `disabled` in `registry/boards.csv`.
3. The next hourly run removes the listings. Removal takes effect within 24 hours.

Our crawler identifies itself as `WalkPathBot/1.0 (+https://github.com/alterj07/walkpath)`,
honours `robots.txt` and `Retry-After`, and never logs in, solves challenges or uses proxies.
Blocking that User-Agent on your side has the same effect as an opt-out.
