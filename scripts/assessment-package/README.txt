SDK migration assessment for application owners

Install Node.js 22 or later. Extract the archive outside the application you want to scan. Check that the scanner starts from the extracted package directory.

  node sdk-assessment.cjs --version
  node sdk-assessment.cjs --help

Choose the recipe for the upgrade you plan. Check which SDK version the application currently uses. Supported recipes are inngest-v3-to-v4 and knock-v0-to-v1.

Run the scanner against an authorized local checkout. Replace the example paths below. Choose a new output file in an existing, private directory outside the checkout.

  node sdk-assessment.cjs assess --recipe inngest-v3-to-v4 --repo "/path/to/application" --out "/path/to/handoff/summary.json" --local-report "/path/to/handoff/private-findings.json"

Open private-findings.json locally for the file paths, lines and actions. Omit --local-report if you only need counts. Keep private-findings.json on your machine. Inspect summary.json before sharing it with your agency or SDK maintainer.

The scanner runs offline. It reads supported JavaScript and TypeScript source, estimates edits in memory and writes the requested reports. Your application code and dependencies stay on your machine. A maintainer can use the aggregate counts to prepare a review brief. Build, runtime and upgrade compatibility require separate verification.

The archive checksum covers all files. Verify the .tgz against its supplied .sha256 file before extracting. On macOS run shasum -a 256 -c sdk-assessment-VERSION.tgz.sha256. On Linux use sha256sum -c sdk-assessment-VERSION.tgz.sha256. Substitute the supplied version number and run the command where both files are stored.
