resource "oci_ons_notification_topic" "alerts" {
  compartment_id = local.compartment_id
  name           = "${local.name}-alerts"
  description    = "WSR research VM alarms"
}

# Pending until the recipient clicks the confirmation link in the email.
resource "oci_ons_subscription" "email" {
  compartment_id = local.compartment_id
  topic_id       = oci_ons_notification_topic.alerts.id
  protocol       = "EMAIL"
  endpoint       = var.alert_email
}

locals {
  vm_filter = "{resourceId = \"${oci_core_instance.vm.id}\"}"
  alarms = {
    # OCI caps pending_duration at 1 h: max over 1 h below 5 % for a further
    # hour means ~2 h without any CPU burst (job died or finished).
    idle = {
      query    = "CpuUtilization[1h]${local.vm_filter}.max() < 5"
      pending  = "PT1H"
      severity = "WARNING"
      body     = "WSR VM CPU below 5% for ~2h: research job died or finished."
    }
    memory = {
      query    = "MemoryUtilization[5m]${local.vm_filter}.mean() > 90"
      pending  = "PT15M"
      severity = "CRITICAL"
      body     = "WSR VM memory above 90% for 15 min: reduce workers or resize."
    }
    # No metrics at all: the instance is stopped, reclaimed or hung.
    not_running = {
      query    = "CpuUtilization[5m]${local.vm_filter}.absent()"
      pending  = "PT15M"
      severity = "CRITICAL"
      body     = "WSR VM reports no metrics for 15 min: instance not running."
    }
  }
}

resource "oci_monitoring_alarm" "vm" {
  for_each = local.alarms

  compartment_id        = local.compartment_id
  metric_compartment_id = local.compartment_id
  display_name          = "${local.name}-${replace(each.key, "_", "-")}"
  namespace             = "oci_computeagent"
  query                 = each.value.query
  pending_duration      = each.value.pending
  severity              = each.value.severity
  body                  = each.value.body
  destinations          = [oci_ons_notification_topic.alerts.id]
  is_enabled            = true
}
