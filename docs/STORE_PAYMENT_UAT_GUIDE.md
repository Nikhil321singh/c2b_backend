# Store Payment UAT Guide

## Scope

This guide covers the non-HSBC parts of the consolidated change request:

- Accounts / store-payment processing.
- Payment Permission Modes 1, 2 and 3.

Customer HSBC payout and SMS template work are outside this test slice.

Before UAT on an existing database, run `npm run db:indexes` once with the UAT
MongoDB environment configured.

## Required test users

Create users under the same test company:

- Company Admin
- Manager with one or more assigned stores
- Store Admin with one store
- Accounts User

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
   - one email event targets Store (if configured), Manager and Company Admin;
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
3. Confirm no payment action is requested and the request is recorded as
   `Payment Done` immediately.

## Negative payment cases

- Accounts User cannot raise requests.
- Manager cannot raise or list requests for an unassigned store.
- Leads from multiple stores cannot be combined.
- A paid or already requested lead cannot be requested again.
- A flagged request cannot be marked paid until it is unflagged.
- Store/company IDs supplied by the browser are ignored; ownership is resolved
  from the authenticated user and selected leads.

## API groups

- `/api/store-payments`

The endpoints are included in generated Swagger coverage.
