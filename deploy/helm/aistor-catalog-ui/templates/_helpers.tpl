{{- define "aistor-ui.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "aistor-ui.fullname" -}}
{{- if .Values.fullnameOverride -}}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- $name := default .Chart.Name .Values.nameOverride -}}
{{- if contains $name .Release.Name -}}
{{- .Release.Name | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}
{{- end -}}

{{- define "aistor-ui.selectorLabels" -}}
app.kubernetes.io/name: {{ include "aistor-ui.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}

{{/* Selects the UI pods only (not the bundled Redis). */}}
{{- define "aistor-ui.uiSelectorLabels" -}}
{{ include "aistor-ui.selectorLabels" . }}
app.kubernetes.io/component: ui
{{- end -}}

{{- define "aistor-ui.labels" -}}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" }}
{{ include "aistor-ui.selectorLabels" . }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
app.kubernetes.io/part-of: aistor
{{- end -}}

{{- define "aistor-ui.secretName" -}}
{{- default (include "aistor-ui.fullname" .) .Values.secrets.existingSecret -}}
{{- end -}}

{{- define "aistor-ui.redisName" -}}
{{- printf "%s-redis" (include "aistor-ui.fullname" .) | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{/* The rendered application config, with the bundled Redis wired in. */}}
{{- define "aistor-ui.config" -}}
{{- $cfg := deepCopy .Values.config -}}
{{- if .Values.redis.enabled -}}
{{- $session := default (dict) $cfg.session -}}
{{- if not $session.store -}}
{{- $_ := set $session "store" (printf "redis://:${REDIS_PASSWORD}@%s:6379/0" (include "aistor-ui.redisName" .)) -}}
{{- end -}}
{{- $_ := set $cfg "session" $session -}}
{{- end -}}
{{- toYaml $cfg -}}
{{- end -}}

{{/* An existing value from the release's Secret, so generated values survive upgrades. */}}
{{- define "aistor-ui.keep" -}}
{{- $root := index . 0 -}}{{- $key := index . 1 -}}{{- $given := index . 2 -}}{{- $gen := index . 3 -}}
{{- if $given -}}
{{- $given -}}
{{- else -}}
{{- $existing := lookup "v1" "Secret" $root.Release.Namespace (include "aistor-ui.fullname" $root) -}}
{{- if and $existing (index $existing.data $key) -}}
{{- index $existing.data $key | b64dec -}}
{{- else if $gen -}}
{{- randAlphaNum 48 -}}
{{- end -}}
{{- end -}}
{{- end -}}
