# Store Payment and Warehouse UAT Guide

## Scope

This guide covers the non-HSBC parts of the consolidated change request:

- Accounts / store-payment processing.
- Payment Permission Modes 1, 2 and 3.
- Warehouse handoff after payment.
- Logistic user assignment and delivery tracking.
- Server-side courier push when an approved courier adapter is configured.

Customer HSBC payout and SMS template work are outside this test slice.

Before UAT on an existing database, run `npm run db:indexes` once with the UAT
MongoDB environment configured.

## Required test users

Create users under the same test company:

- Company Admin
- Manager with one or more assigned stores
- Store Admin with one store
- Accounts User
- Warehouse User
- Logistic User

Super Admin configures the company under **Company Listing → Edit → Store
Payment Permission**.

## Payment modes

### Mode 1 — Company Accounts

1. Configure `COMPANY_ACCOUNTS`.
2. Manager, Company Admin or Store Admin selects eligible leads and clicks
   **Request For Payment**.
3. Confirm status is `Payment Requested`.
4. Accounts User opens **Store Payments**.
5. Test **View**, **Flag**, and **Unflag**.
6. Click **Mark Paid**.
7. Confirm:
   - status is `Payment Done`;
   - Warehouse is `In Warehouse`;
   - one email event targets Store (if configured), Manager, Company Admin and
     Logistic users;
   - a failed email is attempted up to three times and shown in the Accounts
     screen.

### Mode 2 — Manager Funds

1. Configure `MANAGER_FUNDS`.
2. Raise the request.
3. Confirm the assigned Manager, rather than Accounts User, can click
   **Mark Paid**.
4. Confirm the reimbursement receipt email targets the Manager.

### Mode 3 — Pre-paid / Deferred

1. Configure `PREPAID_DEFERRED`.
2. Raise the request.
3. Confirm no payment action is requested and the leads immediately become
   available as `Unassigned` in Warehouse.

## Negative payment cases

- Accounts User, Warehouse User and Logistic User cannot raise requests.
- Manager cannot raise or list requests for an unassigned store.
- Leads from multiple stores cannot be combined.
- A paid or already requested lead cannot be requested again.
- A flagged request cannot be marked paid until it is unflagged.
- Store/company IDs supplied by the browser are ignored; ownership is resolved
  from the authenticated user and selected leads.

## Warehouse flow

1. Log in as Warehouse User and open **Warehouse**.
2. In **Unassigned**, select an active Logistic agent and click **Assign**.
3. Confirm status becomes `Out For Pickup` and assignment actor/time are saved.
4. Log in as the assigned Logistic User and confirm only assigned leads are
   visible and no mutation controls are shown.
5. As Warehouse User, mark **Pickup Complete**.
6. Test cancellation. Confirm Logistic User cannot cancel.
7. As Company Admin or Super Admin, restore a cancelled lead and confirm it
   returns to `Unassigned`.

## Courier push

Courier calls are server-side only. Configure the variables documented in
`.env.uat.example`. Until the endpoint and authentication are configured,
**Push to Logistics** remains disabled while assignment and tracking continue
to work.

For an enabled adapter:

1. Put assigned leads in `Pickup Complete`.
2. Click **Push to Logistics**.
3. Confirm successful leads store the provider/order ID and move to
   `Pushed to Logistics`.
4. Confirm one failed order does not stop the batch, its lead status is
   unchanged, and its error/attempt is retained for review.

## API groups

- `/api/store-payments`
- `/api/warehouse`

The endpoints are included in generated Swagger coverage.
