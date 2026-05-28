# Recipe #47 — Mirth Connect Helm Chart

**Description:** Production-grade Helm chart for Mirth Connect 4.5.2 on Kubernetes 1.28+. StatefulSet topology with persistent appdata, externalized DB credentials, init container for custom JAR fetching, optional JMX Prometheus exporter sidecar, HPA, PDB, and ingress.

**Use case:** Running Mirth as a managed service in EKS / GKE / AKS / OpenShift. Designed for teams that already have a managed PostgreSQL (RDS, Cloud SQL) and want everything else codified.

**Requirements:**
- Kubernetes 1.28+
- Helm 3.13+
- An external PostgreSQL 14+ (RDS Multi-AZ recommended)
- StorageClass that supports `ReadWriteOnce` PVCs
- (Optional) cert-manager for TLS, kube-prometheus-stack for ServiceMonitor, External Secrets Operator

**Tested on:** Mirth Connect `4.5.2`, Helm `3.13`, k3d `5.6`, EKS `1.29`.
**Author:** Nirmitee.io | **License:** MIT

---

## What this gives you

- **StatefulSet** with stable pod identity (`mirth-0`, `mirth-1`, ...) — each pod gets its own `appdata` PVC for keystore + local exports
- **Two services:** `*-admin` (ClusterIP, 8443) for the API and `*-mllp` (NodePort/LB) for HL7 ingress
- **ConfigMap** rendering `mirth.properties` from values
- **Secret-driven DB credentials** — works with External Secrets Operator
- **InitContainer** that fetches JDBC drivers, HAPI-FHIR, Vault libs, etc. from a manifest with optional SHA-256 verification
- **HPA + PDB** for graceful scaling and voluntary-disruption protection
- **Optional Prometheus JMX exporter sidecar** with ServiceMonitor for Mirth channel metrics
- **Non-root containerSecurityContext** with all capabilities dropped — HIPAA-aligned baseline

## Install

```bash
# 1. Create the credential secrets your values reference
kubectl create namespace mirth
kubectl -n mirth create secret generic mirth-db-credentials \
    --from-literal=username=mirthdb \
    --from-literal=password='REPLACE_ME'
kubectl -n mirth create secret generic mirth-admin-credentials \
    --from-literal=username=admin \
    --from-literal=password='REPLACE_ME'

# 2. Install
helm install mirth deploy/helm/mirth-connect \
    --namespace mirth \
    --set database.host=postgres.mirth.svc.cluster.local \
    --set persistence.storageClass=gp3
```

Validate the chart locally:

```bash
helm lint deploy/helm/mirth-connect
helm template release-name deploy/helm/mirth-connect | kubectl apply --dry-run=client -f -
```

## Test

After install, wait for both pods to reach `Ready` then:

```bash
kubectl -n mirth get pods -l app.kubernetes.io/name=mirth-connect
kubectl -n mirth port-forward svc/mirth-mirth-connect-admin 8443:8443 &
curl -sk https://localhost:8443/api/server/version
```

Send an HL7 v2 message via NodePort:

```bash
NODE_IP=$(kubectl get nodes -o jsonpath='{.items[0].status.addresses[?(@.type=="InternalIP")].address}')
printf '\x0bMSH|^~\\&|TEST|TEST|MIRTH|K8S|20260528120000||ADT^A01|1|P|2.5\rPID|1||PAT1\r\x1c\x0d' \
    | nc "$NODE_IP" 30661
```

## Customize

### Use External Secrets Operator (recommended for prod)

Don't store DB credentials in `kubectl create secret`. Instead:

```yaml
# externalsecret.yaml
apiVersion: external-secrets.io/v1beta1
kind: ExternalSecret
metadata:
  name: mirth-db-credentials
  namespace: mirth
spec:
  refreshInterval: 1h
  secretStoreRef:
    name: aws-secrets-manager
    kind: ClusterSecretStore
  target:
    name: mirth-db-credentials
  data:
    - secretKey: username
      remoteRef: { key: prod/mirth/db, property: username }
    - secretKey: password
      remoteRef: { key: prod/mirth/db, property: password }
```

The chart will pick up the synced Kubernetes Secret automatically.

### Custom libraries (JDBC drivers, HAPI-FHIR, Vault SDK)

```yaml
customLibJars:
  - name: postgresql
    url: https://jdbc.postgresql.org/download/postgresql-42.7.3.jar
    sha256: "67a0e25e..."
  - name: hapi-fhir-base
    url: https://repo1.maven.org/maven2/ca/uhn/hapi/fhir/hapi-fhir-base/7.0.0/hapi-fhir-base-7.0.0.jar
```

The initContainer downloads each into `/opt/connect/custom-lib`. Mirth picks them up at startup.

### Ingress with TLS

```yaml
ingress:
  enabled: true
  className: nginx
  annotations:
    cert-manager.io/cluster-issuer: letsencrypt-prod
    nginx.ingress.kubernetes.io/backend-protocol: HTTPS
  hosts:
    - host: mirth.example.com
      paths:
        - path: /
          pathType: Prefix
  tls:
    - secretName: mirth-tls
      hosts: [ mirth.example.com ]
```

### Prometheus monitoring

```yaml
monitoring:
  enabled: true
  serviceMonitor:
    enabled: true
    namespace: monitoring
    labels:
      release: kube-prometheus-stack
```

The JMX exporter sidecar scrapes Mirth's MBeans (`com.mirth.connect.donkey:type=channels,...`) and exposes Prometheus metrics on `:9404/metrics`.

### Pin a channel to one pod (single-writer source connectors)

Mirth's OSS edition has no cluster-wide locking. For a file-reader or DB-reader channel that must run on exactly one pod, use a node selector or pod-affinity trick:

```yaml
nodeSelector:
  mirth.io/role: reader
```

…and only label one node with that.

## Branch protection / GitOps

This chart is designed for ArgoCD / Flux:

```yaml
# argocd app
spec:
  source:
    repoURL: https://github.com/Nirmitee-tech/mirth-connect-cookbook
    path: deploy/helm/mirth-connect
    helm:
      valueFiles:
        - values.yaml
        - values.prod.yaml
```

## HIPAA notes

- **Encryption at rest:** PVC storage class must use encrypted volumes (gp3 + KMS on AWS, pd-ssd + CMEK on GCP).
- **Encryption in transit:** Admin API is HTTPS by default. For MLLP, terminate TLS at an ingress or use the `mllps-tls-mutual-auth` recipe (#30).
- **Audit logs:** Stream pod stdout to Loki / CloudWatch; Mirth's audit table lives in the DB and is preserved across pod restarts.
- **Least privilege:** Container runs as UID 1000 with all caps dropped. The pod's ServiceAccount has no extra permissions by default.
- **Backups:** Snapshot the PostgreSQL backend daily; appdata PVCs are recoverable from PG (channel state lives there).

## File listing

| File | Purpose |
|---|---|
| `Chart.yaml` | Helm chart metadata |
| `values.yaml` | All tunables, documented inline |
| `templates/statefulset.yaml` | Mirth pods + JMX sidecar + initContainer |
| `templates/service.yaml` | Admin (ClusterIP) + MLLP (NodePort) services |
| `templates/configmap.yaml` | mirth.properties + custom-lib manifest + JMX rules |
| `templates/ingress.yaml` | Optional ingress with TLS |
| `templates/hpa.yaml` | Optional HorizontalPodAutoscaler |
| `templates/pdb.yaml` | PodDisruptionBudget |
| `templates/servicemonitor.yaml` | Prometheus Operator integration |
| `templates/serviceaccount.yaml` | ServiceAccount (supports IRSA via annotations) |
| `templates/_helpers.tpl` | Template helpers |
