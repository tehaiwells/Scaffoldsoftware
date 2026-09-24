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

Yard and site boundaries are stored as a closed ring of 3 to 100 whole-millimetre corner points (a legacy ring with more corners can be kept as it is). The shape editor sends corners; eight-direction perimeter segments with true lengths (a 5 m diagonal moves 5/sqrt(2) m on each axis) are still accepted as legacy input. Degenerate, crossing, spiked, overlapping and double-back boundaries are rejected; a corner in the middle of a straight side is not a shape change. Entire rectangular footprints must fit concave polygons. Corners are numbered from the top-most, then left-most corner going clockwise on the plan, the same order on every plan and in the editor.

Each yard and site carries shapeRev, a shape revision that starts at 1 and goes up by one on every boundary, fixture, rename or height save (and on a site rename). A save carries the shapeRev the editor opened with and is refused if it has changed; the record version is not compared, because automatic sweeps and parking changes bump it. A shape change relocates stock it covers (RELOCATED events), stops crew orders, stops waiting turns and layout steps whose spot it covers and re-plans other movements; it is refused while a turn or layout load on the forks heads for a covered spot. Boundary previews run inside a rolled-back savepoint and write nothing.

Frame and loaded-envelope dimensions are separate. Placement uses integer coordinates, 0/90-degree orientation, full support and no overhang. A turn is a same-location MOVE to the other orientation, performed by the crew: TURN_PLANNED records the plan (anchor and number of moves) and TURNED records the change of orientation at set-down, with the old and new spot; the stillage remembers where it was before its last turn so a second turn puts it back exactly. The swept circle of the turning load must be clear, otherwise the load is carried to a clear circle nearby (task.turnAt) and back; with neither, the task is BLOCKED with No room to turn. A pile turns as a whole through a chained plan. Yard stacks are limited to seven and the configured height; truck stacks to two. Covered or reserved supports cannot be moved.

Routes use a conservative 500 mm grid with 100 mm swept-edge checks and the larger machine/load footprint. Obstacles/fences cannot be skipped. No route means BLOCKED. One active machine route per handling area avoids crossing loads. Detailed operator approach, crane physics and continuous movement visuals remain gaps.

## Stocktake

OPEN counts snapshot expected lines and lock affected/incoming movements. Observations preserve expected, observed, counter and reason. Only stock.adjust can approve. Approval verifies expectations, applies signed variances atomically, appends ledger events and stores approver/time. Cancel releases locks without changing stock.
