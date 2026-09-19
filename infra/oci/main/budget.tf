resource "oci_budget_budget" "wsr" {
  compartment_id = var.tenancy_ocid
  display_name   = local.name
  description    = "WSR research compartment"
  amount         = var.budget_monthly_usd
  reset_period   = "MONTHLY"
  target_type    = "COMPARTMENT"
  targets        = [local.compartment_id]
}

resource "oci_budget_alert_rule" "actual_50" {
  budget_id      = oci_budget_budget.wsr.id
  display_name   = "actual-50pct"
  type           = "ACTUAL"
  threshold      = 50
  threshold_type = "PERCENTAGE"
  recipients     = var.alert_email
  message        = "WSR research spend reached 50% of the monthly budget."
}

resource "oci_budget_alert_rule" "forecast_100" {
  budget_id      = oci_budget_budget.wsr.id
  display_name   = "forecast-100pct"
  type           = "FORECAST"
  threshold      = 100
  threshold_type = "PERCENTAGE"
  recipients     = var.alert_email
  message        = "WSR research spend is forecast to exceed the monthly budget."
}
