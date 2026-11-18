"""Build the interactive page and deploy it to AWS (S3 + CloudFront).

Uses the AWS CLI directly (this AWS organization blocks CloudFormation). Every
step is idempotent: rerunning finds and reuses existing resources.

What it sets up:
  * a private S3 bucket: all public access blocked, encrypted, versioned
    (old versions expire after 30 days), HTTPS-only bucket policy
  * a CloudFront distribution in front of it: HTTPS, HTTP/2+3, compression,
    the only principal allowed to read the bucket (Origin Access Control)
  * a security-headers policy (CSP, HSTS, no framing, nosniff)
  * the custom domain (nnplayground.dev and www.): an ACM certificate, the domain
    names on the distribution, and a CloudFront Function that 301-redirects
    www.nnplayground.dev and the *.cloudfront.net address to https://nnplayground.dev.
    DNS lives at Cloudflare; if the certificate isn't validated yet, the script
    prints the records to add and skips this step.

Then it builds web/ into build/web/ with content-hashed asset names (cached for
a year) and uploads them, uploading the HTML pages (never cached) last.

Usage:
    python deploy.py                 # build + provision + upload
    python deploy.py --build-only    # just build build/web
    python deploy.py --prune         # also delete files left from older deploys
    python deploy.py --domain ""     # skip custom-domain setup
    python deploy.py --site my-site --region us-east-1

Requires the AWS CLI v2, signed in to the target account.
"""

import argparse
import hashlib
import json
import re
import shutil
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent
DOMAIN = "nnplayground.dev"  # the canonical address; www. redirects to it
SRC = ROOT / "web"
BUILD = ROOT / "build" / "web"

PAGES = ["index.html", "author.html"]  # served under their own names, never cached stale
ASSETS = ["style.css", "nn.js", "viz.js", "explain.js", "app.js", "mnist-data.js", "favicon.svg"]
# Files that must keep their exact names: crawlers look for robots.txt and sitemap.xml
# at the site root, and og-image.png is referenced by absolute URL in the pages' meta tags.
STATIC = ["robots.txt", "sitemap.xml", "og-image.png"]
CONTENT_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".svg": "image/svg+xml",
    ".txt": "text/plain; charset=utf-8",
    ".xml": "application/xml; charset=utf-8",
    ".png": "image/png",
}
IMMUTABLE = "public, max-age=31536000, immutable"  # hashed names never change content
NO_CACHE = "no-cache"                                # always revalidate the HTML pages
SHORT_CACHE = "public, max-age=3600"                 # fixed-name files: refresh within an hour

# Browser security policy. The page needs img-src data: (neuron weight images are
# data URLs) and must never use inline <script>, inline style="" attributes or eval.
CSP = ("default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; "
       "connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'")
CACHING_OPTIMIZED = "658327ea-f89d-4fab-a63d-7e88639e58f6"  # AWS managed cache policy


# ---- helpers -----------------------------------------------------------------

def aws(*args: str, check: bool = True):
    """Run an AWS CLI command and return parsed JSON output (or None)."""
    result = subprocess.run(["aws", *args, "--output", "json"], capture_output=True, text=True)
    if result.returncode != 0:
        if not check:
            return None
        sys.exit(f"aws {' '.join(args[:2])} failed:\n{result.stderr.strip()}")
    return json.loads(result.stdout) if result.stdout.strip() else None


def step(msg: str) -> None:
    print(f"- {msg}", flush=True)


# ---- build ---------------------------------------------------------------------

def build() -> list[Path]:
    if not (SRC / "mnist-data.js").exists():
        sys.exit("web/mnist-data.js is missing. Generate it first: python export_web_data.py")
    shutil.rmtree(BUILD, ignore_errors=True)
    BUILD.mkdir(parents=True)
    pages = {p: (SRC / p).read_text(encoding="utf-8") for p in PAGES}
    for name in ASSETS:
        data = (SRC / name).read_bytes()
        stem, ext = name.rsplit(".", 1)
        hashed = f"{stem}.{hashlib.sha256(data).hexdigest()[:10]}.{ext}"
        (BUILD / hashed).write_bytes(data)
        total_refs = 0
        for page, html in pages.items():
            pages[page], count = re.subn(rf'(src|href)="{re.escape(name)}"', rf'\1="{hashed}"', html)
            total_refs += count
        if total_refs == 0:
            sys.exit(f"{name} isn't referenced by any page; remove it from ASSETS or link it")
    for page, html in pages.items():
        (BUILD / page).write_text(html, encoding="utf-8")
    for name in STATIC:
        shutil.copyfile(SRC / name, BUILD / name)
    files = sorted(BUILD.iterdir())
    total = sum(f.stat().st_size for f in files)
    print(f"Built {len(files)} files ({total / 1e6:.1f} MB) in {BUILD.relative_to(ROOT)}")
    return files


# ---- infrastructure --------------------------------------------------------------

def ensure_bucket(bucket: str, region: str) -> None:
    exists = subprocess.run(["aws", "s3api", "head-bucket", "--bucket", bucket, "--region", region],
                            capture_output=True).returncode == 0
    if exists:
        step(f"bucket {bucket} exists")
    else:
        step(f"creating bucket {bucket}")
        args = ["s3api", "create-bucket", "--bucket", bucket, "--region", region]
        if region != "us-east-1":
            args += ["--create-bucket-configuration", json.dumps({"LocationConstraint": region})]
        aws(*args)
    # (Re)apply settings every run so the bucket always matches this script.
    aws("s3api", "put-public-access-block", "--bucket", bucket, "--region", region,
        "--public-access-block-configuration", json.dumps({
            "BlockPublicAcls": True, "IgnorePublicAcls": True,
            "BlockPublicPolicy": True, "RestrictPublicBuckets": True}))
    aws("s3api", "put-bucket-ownership-controls", "--bucket", bucket, "--region", region,
        "--ownership-controls", json.dumps({"Rules": [{"ObjectOwnership": "BucketOwnerEnforced"}]}))
    aws("s3api", "put-bucket-encryption", "--bucket", bucket, "--region", region,
        "--server-side-encryption-configuration", json.dumps({
            "Rules": [{"ApplyServerSideEncryptionByDefault": {"SSEAlgorithm": "AES256"}}]}))
    aws("s3api", "put-bucket-versioning", "--bucket", bucket, "--region", region,
        "--versioning-configuration", json.dumps({"Status": "Enabled"}))
    aws("s3api", "put-bucket-lifecycle-configuration", "--bucket", bucket, "--region", region,
        "--lifecycle-configuration", json.dumps({"Rules": [{
            "ID": "ExpireOldVersions", "Status": "Enabled", "Filter": {},
            "NoncurrentVersionExpiration": {"NoncurrentDays": 30},
            "AbortIncompleteMultipartUpload": {"DaysAfterInitiation": 7}}]}))
    aws("s3api", "put-bucket-tagging", "--bucket", bucket, "--region", region,
        "--tagging", json.dumps({"TagSet": [{"Key": "project", "Value": "inside-a-neural-network"}]}))


def ensure_oac(site: str) -> str:
    name = f"{site}-oac"
    items = aws("cloudfront", "list-origin-access-controls",
                "--query", f"OriginAccessControlList.Items[?Name=='{name}'].Id")
    if items:
        step(f"origin access control {name} exists")
        return items[0]
    step(f"creating origin access control {name}")
    created = aws("cloudfront", "create-origin-access-control", "--origin-access-control-config", json.dumps({
        "Name": name, "Description": "CloudFront access to the private site bucket",
        "SigningProtocol": "sigv4", "SigningBehavior": "always", "OriginAccessControlOriginType": "s3"}))
    return created["OriginAccessControl"]["Id"]


def ensure_headers_policy(site: str) -> str:
    name = f"{site}-security-headers"
    config = {
        "Name": name,
        "Comment": "Security headers for the Inside a Neural Network page",
        "SecurityHeadersConfig": {
            "ContentSecurityPolicy": {"Override": True, "ContentSecurityPolicy": CSP},
            "StrictTransportSecurity": {"Override": True, "AccessControlMaxAgeSec": 31536000,
                                        "IncludeSubdomains": True},
            "ContentTypeOptions": {"Override": True},
            "FrameOptions": {"Override": True, "FrameOption": "DENY"},
            "ReferrerPolicy": {"Override": True, "ReferrerPolicy": "strict-origin-when-cross-origin"},
        },
    }
    items = aws("cloudfront", "list-response-headers-policies", "--type", "custom",
                "--query", f"ResponseHeadersPolicyList.Items[?ResponseHeadersPolicy.ResponseHeadersPolicyConfig.Name=='{name}'].ResponseHeadersPolicy.Id")
    if items:
        policy_id = items[0]
        current = aws("cloudfront", "get-response-headers-policy-config", "--id", policy_id)
        if current["ResponseHeadersPolicyConfig"] == config:
            step(f"security headers policy {name} is up to date")
        else:
            step(f"updating security headers policy {name}")
            aws("cloudfront", "update-response-headers-policy", "--id", policy_id,
                "--if-match", current["ETag"], "--response-headers-policy-config", json.dumps(config))
        return policy_id
    step(f"creating security headers policy {name}")
    created = aws("cloudfront", "create-response-headers-policy",
                  "--response-headers-policy-config", json.dumps(config))
    return created["ResponseHeadersPolicy"]["Id"]


def ensure_distribution(site: str, bucket: str, region: str, oac_id: str, headers_id: str):
    """Return (distribution, created?). Distributions are found by their Comment."""
    comment = f"{site} (Inside a Neural Network)"
    found = aws("cloudfront", "list-distributions",
                "--query", f"DistributionList.Items[?Comment=='{comment}'].{{Id:Id,ARN:ARN,DomainName:DomainName}}")
    if found:
        step(f"CloudFront distribution {found[0]['Id']} exists")
        return found[0], False
    step("creating CloudFront distribution")
    config = {
        "CallerReference": f"{site}-{int(time.time())}",
        "Comment": comment,
        "Enabled": True,
        "DefaultRootObject": "index.html",
        "HttpVersion": "http2and3",
        "IsIPV6Enabled": True,
        "PriceClass": "PriceClass_100",
        "Origins": {"Quantity": 1, "Items": [{
            "Id": "site-bucket",
            "DomainName": f"{bucket}.s3.{region}.amazonaws.com",
            "OriginAccessControlId": oac_id,
            "S3OriginConfig": {"OriginAccessIdentity": ""},
        }]},
        "DefaultCacheBehavior": {
            "TargetOriginId": "site-bucket",
            "ViewerProtocolPolicy": "redirect-to-https",
            "AllowedMethods": {"Quantity": 2, "Items": ["GET", "HEAD"],
                               "CachedMethods": {"Quantity": 2, "Items": ["GET", "HEAD"]}},
            "Compress": True,
            "CachePolicyId": CACHING_OPTIMIZED,
            "ResponseHeadersPolicyId": headers_id,
        },
        "ViewerCertificate": {"CloudFrontDefaultCertificate": True},
    }
    d = aws("cloudfront", "create-distribution", "--distribution-config", json.dumps(config))["Distribution"]
    return {"Id": d["Id"], "ARN": d["ARN"], "DomainName": d["DomainName"]}, True


def ensure_bucket_policy(bucket: str, region: str, distribution_arn: str) -> None:
    policy = {
        "Version": "2012-10-17",
        "Statement": [
            {   # only this distribution may read objects (SourceArn prevents confused-deputy use)
                "Sid": "AllowCloudFrontRead", "Effect": "Allow",
                "Principal": {"Service": "cloudfront.amazonaws.com"},
                "Action": "s3:GetObject", "Resource": f"arn:aws:s3:::{bucket}/*",
                "Condition": {"StringEquals": {"AWS:SourceArn": distribution_arn}},
            },
            {
                "Sid": "DenyInsecureTransport", "Effect": "Deny", "Principal": "*", "Action": "s3:*",
                "Resource": [f"arn:aws:s3:::{bucket}", f"arn:aws:s3:::{bucket}/*"],
                "Condition": {"Bool": {"aws:SecureTransport": "false"}},
            },
        ],
    }
    step("applying bucket policy (CloudFront-only reads, HTTPS-only)")
    aws("s3api", "put-bucket-policy", "--bucket", bucket, "--region", region, "--policy", json.dumps(policy))


# ---- custom domain ---------------------------------------------------------------

def ensure_certificate(domain: str):
    """Return the ARN of an ISSUED certificate for domain + www.domain, or None.

    CloudFront only accepts certificates from us-east-1. If the certificate is
    still waiting for DNS validation, print the records to add and return None.
    """
    region = ["--region", "us-east-1"]
    arn = aws("acm", "list-certificates", *region, "--certificate-statuses", "ISSUED", "PENDING_VALIDATION",
              "--query", f"CertificateSummaryList[?DomainName=='{domain}'].CertificateArn | [0]")
    if not arn:
        step(f"requesting certificate for {domain} and www.{domain}")
        arn = aws("acm", "request-certificate", *region, "--domain-name", domain,
                  "--subject-alternative-names", f"www.{domain}", "--validation-method", "DNS",
                  "--idempotency-token", re.sub(r"\W", "", domain)[:32],
                  "--query", "CertificateArn")
        time.sleep(5)  # validation records take a moment to appear
    cert = aws("acm", "describe-certificate", *region, "--certificate-arn", arn, "--query", "Certificate")
    if cert["Status"] == "ISSUED":
        step(f"certificate for {domain} is issued")
        return arn
    print(f"\n  The certificate for {domain} is {cert['Status']}. Add these DNS records at Cloudflare")
    print("  (Proxy status: DNS only), wait a few minutes, then rerun deploy.py:")
    for opt in cert.get("DomainValidationOptions", []):
        rr = opt.get("ResourceRecord")
        if rr:
            print(f"    CNAME  {rr['Name'].rstrip('.')}  ->  {rr['Value'].rstrip('.')}")
    print("  Skipping the custom-domain step for now.\n")
    return None


def redirect_function_code(domain: str) -> str:
    """CloudFront Function: send every host other than the canonical domain there with a 301."""
    return f"""function handler(event) {{
  var request = event.request;
  var host = request.headers.host ? request.headers.host.value : '';
  if (host === '{domain}') {{
    return request;
  }}
  var parts = [];
  for (var key in request.querystring) {{
    var entry = request.querystring[key];
    var values = entry.multiValue ? entry.multiValue : [entry];
    for (var i = 0; i < values.length; i++) {{
      parts.push(values[i].value === '' ? key : key + '=' + values[i].value);
    }}
  }}
  var location = 'https://{domain}' + request.uri + (parts.length ? '?' + parts.join('&') : '');
  return {{
    statusCode: 301,
    statusDescription: 'Moved Permanently',
    headers: {{ location: {{ value: location }}, 'cache-control': {{ value: 'max-age=3600' }} }}
  }};
}}
"""


def ensure_redirect_function(site: str, domain: str) -> str:
    """Create or update the redirect function and publish it; return its LIVE ARN."""
    name = f"{site}-canonical-redirect"
    code_file = BUILD.parent / "redirect-function.js"
    code = redirect_function_code(domain)
    code_file.write_text(code, encoding="utf-8")
    config = json.dumps({"Comment": f"301 to https://{domain}", "Runtime": "cloudfront-js-2.0"})
    existing = aws("cloudfront", "describe-function", "--name", name, "--stage", "DEVELOPMENT", check=False)
    if existing is None:
        step(f"creating redirect function {name}")
        etag = aws("cloudfront", "create-function", "--name", name, "--function-config", config,
                   "--function-code", f"fileb://{code_file}")["ETag"]
    else:
        current = BUILD.parent / "redirect-function.current.js"
        subprocess.run(["aws", "cloudfront", "get-function", "--name", name, "--stage", "LIVE", str(current)],
                       capture_output=True)
        if current.exists() and current.read_text(encoding="utf-8") == code:
            step(f"redirect function {name} is up to date")
            return existing["FunctionSummary"]["FunctionMetadata"]["FunctionARN"]
        step(f"updating redirect function {name}")
        etag = aws("cloudfront", "update-function", "--name", name, "--if-match", existing["ETag"],
                   "--function-config", config, "--function-code", f"fileb://{code_file}")["ETag"]
    published = aws("cloudfront", "publish-function", "--name", name, "--if-match", etag)
    return published["FunctionSummary"]["FunctionMetadata"]["FunctionARN"]


def ensure_distribution_domain(dist_id: str, domain: str, cert_arn: str, function_arn: str) -> bool:
    """Attach domain + www.domain, the certificate and the redirect function. Returns True if changed."""
    current = aws("cloudfront", "get-distribution-config", "--id", dist_id)
    config, etag = current["DistributionConfig"], current["ETag"]
    aliases = sorted([domain, f"www.{domain}"])
    wanted_cert = {"ACMCertificateArn": cert_arn, "SSLSupportMethod": "sni-only",
                   "MinimumProtocolVersion": "TLSv1.2_2021"}
    wanted_functions = {"Quantity": 1, "Items": [{"EventType": "viewer-request", "FunctionARN": function_arn}]}
    behavior = config["DefaultCacheBehavior"]
    up_to_date = (
        sorted(config.get("Aliases", {}).get("Items", [])) == aliases
        and config["ViewerCertificate"].get("ACMCertificateArn") == cert_arn
        and behavior.get("FunctionAssociations", {}).get("Items", []) == wanted_functions["Items"]
    )
    if up_to_date:
        step(f"CloudFront already serves {domain} and www.{domain}")
        return False
    step(f"attaching {domain} and www.{domain} to CloudFront (with redirects)")
    config["Aliases"] = {"Quantity": len(aliases), "Items": aliases}
    config["ViewerCertificate"] = wanted_cert
    behavior["FunctionAssociations"] = wanted_functions
    aws("cloudfront", "update-distribution", "--id", dist_id, "--if-match", etag,
        "--distribution-config", json.dumps(config))
    return True


# ---- upload --------------------------------------------------------------------

def upload(files: list[Path], bucket: str, region: str) -> None:
    # Assets first, pages last: new HTML only goes live once the files it links to exist.
    ordered = [f for f in files if f.name not in PAGES] + [BUILD / p for p in PAGES]
    for f in ordered:
        cache = NO_CACHE if f.name in PAGES else SHORT_CACHE if f.name in STATIC else IMMUTABLE
        step(f"uploading {f.name}")
        aws("s3", "cp", str(f), f"s3://{bucket}/{f.name}", "--region", region,
            "--content-type", CONTENT_TYPES[f.suffix], "--cache-control", cache, "--only-show-errors")


def prune(files: list[Path], bucket: str, region: str) -> None:
    keep = {f.name for f in files}
    keys = aws("s3api", "list-objects-v2", "--bucket", bucket, "--region", region,
               "--query", "Contents[].Key") or []
    for key in keys:
        if key not in keep:
            step(f"removing old {key}")
            aws("s3", "rm", f"s3://{bucket}/{key}", "--region", region, "--only-show-errors")


def main():
    parser = argparse.ArgumentParser(description="Build and deploy the interactive MNIST page")
    parser.add_argument("--site", default="inside-a-neural-network", help="name prefix for AWS resources")
    parser.add_argument("--region", default="us-east-1", help="region for the S3 bucket")
    parser.add_argument("--build-only", action="store_true")
    parser.add_argument("--prune", action="store_true", help="delete files left over from older deploys")
    parser.add_argument("--no-wait", action="store_true", help="don't wait for CloudFront changes to go live")
    parser.add_argument("--domain", default=DOMAIN, help='custom domain to attach ("" to skip)')
    args = parser.parse_args()

    files = build()
    if args.build_only:
        return

    account = aws("sts", "get-caller-identity", "--query", "Account")
    bucket = f"{args.site}-{account}"  # bucket names are global; the account ID keeps this one unique
    print("Provisioning AWS resources:")
    ensure_bucket(bucket, args.region)
    oac_id = ensure_oac(args.site)
    headers_id = ensure_headers_policy(args.site)
    dist, created = ensure_distribution(args.site, bucket, args.region, oac_id, headers_id)
    ensure_bucket_policy(bucket, args.region, dist["ARN"])

    domain_changed, url = False, f"https://{dist['DomainName']}/"
    if args.domain:
        cert_arn = ensure_certificate(args.domain)
        if cert_arn:
            function_arn = ensure_redirect_function(args.site, args.domain)
            domain_changed = ensure_distribution_domain(dist["Id"], args.domain, cert_arn, function_arn)
            url = f"https://{args.domain}/"

    print("Uploading site:")
    upload(files, bucket, args.region)
    if args.prune:
        prune(files, bucket, args.region)

    if (created or domain_changed) and not args.no_wait:
        step("waiting for CloudFront to roll out the change (usually 5-10 minutes)")
        aws("cloudfront", "wait", "distribution-deployed", "--id", dist["Id"])
    print(f"\nLive at {url}")


if __name__ == "__main__":
    main()
