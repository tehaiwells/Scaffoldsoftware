# Implemented domain invariants

## Stock and custody

Contents lines belong to physical containers. Each container has one custody location: yard/site storage, truck or handling equipment. Reservations, condition and movement state are independent. A travelling truck retains its load. Allocated/in-transit never duplicate stock locations.

Opening receipts and approved variances change owned totals through audited events. Ordinary moves change location, not quantity. Partial picking subtracts the exact reservation from the source and puts it into an existing empty target container on equipment at pickup. No container is invented. Damage/quarantine does not remove ownership.

Counts, mm and grams are bounded integers. Payload includes quantity × unit mass and tare exactly once. NULL never means zero. Missing weights block the affected move; missing operating pack quantity blocks automatic allocation.

## Movement

QUEUED → RESERVED → ASSIGNED → TRAVELLING_TO_PICKUP → PICKING → CARRYING → PLACING → COMPLETE.

A queued command already reserves exact stock, destination space and payload transactionally. RESERVED waits for a free handling area. Missing equipment/path yields BLOCKED. Pickup transfers custody to equipment. Successful placement revalidates destination and transfers custody to storage/truck. The frontend only displays persisted state.

BLOCKED preserves reason and previous state; Retry resumes it. Pre-pickup cancellation releases only valid task reservations. Post-pickup cancellation is rejected: cargo remains on equipment until valid placement. FAILED is reserved as a terminal value; no destructive failure transition exists. Busy resources cannot be removed or assigned twice.

## Requests and delivery

Requests specify one exact product/site/quantity. Allocation selects configured full packs first, then other eligible packs, ordered by name/ID. The final partial quantity requires an existing empty container and worker/equipment repacking task. Shortages reject atomically; no excess material is sent. A combined multi-line request editor remains unfinished.

Dispatch rejects open loading work and revalidates cargo. Each trip has one destination. Arrival changes truck status only. A container counts as delivered once it has been placed off the truck on that delivery; the delivery completes when every manifest container has been placed, or when the truck departs again (DELIVERED if anything was placed, otherwise RETURNED). Returns reuse movement/loading/dispatch services. Archiving requires no assets, unresolved requests/counts or active movements and preserves history.

## Geometry

Eight-direction perimeter segments use true lengths. A 5 m diagonal moves 5/sqrt(2) m on each axis. Users explicitly confirm the closing edge; endpoint tolerance is 1 mm. Degenerate, crossing, overlapping and double-back boundaries are rejected. Entire rectangular footprints must fit concave polygons.

Frame and loaded-envelope dimensions are separate. Placement uses integer coordinates, 0/90-degree orientation, full support and no overhang. Yard stacks are limited to seven and the configured height; truck stacks to two. Covered or reserved supports cannot be moved.

Routes use a conservative 500 mm grid with 100 mm swept-edge checks and the larger machine/load footprint. Obstacles/fences cannot be skipped. No route means BLOCKED. One active machine route per handling area avoids crossing loads. Detailed operator approach, crane physics and continuous movement visuals remain gaps.

## Stocktake

OPEN counts snapshot expected lines and lock affected/incoming movements. Observations preserve expected, observed, counter and reason. Only stock.adjust can approve. Approval verifies expectations, applies signed variances atomically, appends ledger events and stores approver/time. Cancel releases locks without changing stock.
